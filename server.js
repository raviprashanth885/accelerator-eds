const dotenv = require('dotenv');
dotenv.config({ quiet: true });

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { Client: McpClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { convert, toCsv, TYPE_MAP, SHEET_COLUMNS } = require('./converter-core');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// dotenv.config() only ever runs once, at process startup, so process.env
// stays frozen at whatever .env held at boot - editing .env afterward (e.g.
// dropping in a freshly-refreshed DA_LIVE_IMS_TOKEN, which expires every
// ~24h) silently keeps failing with a 401 until the process is restarted by
// hand. Re-reading and re-parsing .env on every call sidesteps that: the
// token is always whatever's currently on disk, no restart required.
const ENV_PATH = path.join(__dirname, '.env');
function getEnvVar(key) {
  try {
    const parsed = dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
    if (key in parsed) return parsed[key];
  } catch (e) {
    // .env missing or unreadable - fall through to whatever process.env has.
  }
  return process.env[key];
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Returns JSON: { csv, report, rows } — used by the upload page to show the
// preview + review list, then trigger the CSV download client-side.
app.post('/api/convert', upload.single('afModel'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach an AF model.json export.' });
  }

  let afModel;
  try {
    afModel = JSON.parse(req.file.buffer.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: "That file isn't valid JSON." });
  }

  if (!afModel.items) {
    return res.status(400).json({ error: 'No "items" tree at the top level — this doesn\'t look like an AF guideContainer model.json export.' });
  }

  const { rows, report } = convert(afModel);
  const csv = toCsv(rows);

  // Also drop a copy in ./output so it's on disk alongside the repo, not just
  // in the browser's Downloads folder.
  const safeBase = path.basename(req.file.originalname, path.extname(req.file.originalname))
    .replace(/[^a-z0-9_-]+/gi, '-') || 'output';
  const outputFilename = `${safeBase}.csv`;
  fs.writeFileSync(path.join(OUTPUT_DIR, outputFilename), csv);

  const result = {
    filename: req.file.originalname,
    csv,
    report,
    rows,
    savedAs: `output/${outputFilename}`,
  };

  // Same direct-to-da.live push the chat flow already has - this route just
  // never had a target path to push to before, since a raw file upload
  // carries no da.live destination on its own. The upload UI now asks for
  // one and sends it as a regular form field alongside the file; skipped
  // entirely (falls back to copy/download only) if the author leaves it
  // blank or DA_LIVE_IMS_TOKEN isn't configured, same as the chat flow.
  const { formPath } = req.body;
  if (formPath && getEnvVar('DA_LIVE_IMS_TOKEN')) {
    try {
      result.daLive = await pushToDaLive(formPath, rows);
      result.formPath = formPath;
    } catch (pushErr) {
      result.daLiveError = pushErr.message;
    }
  }

  res.json(result);
});

// Pushes rows the client already has (from a prior /api/convert response)
// to a da.live path supplied afterward - the chat-side answer to "where
// should this go", asked as a normal chat message instead of a native
// browser prompt() popup. Deliberately not routed through /api/chat: the
// path is a plain string being captured, not something that needs a model
// to interpret, so this skips the LLM entirely - no tokens, no latency,
// same reasoning as the direct-MCP push optimization elsewhere in this file.
app.post('/api/push', async (req, res) => {
  const { formPath, rows } = req.body || {};
  if (!formPath || typeof formPath !== 'string') {
    return res.status(400).json({ error: 'formPath is required.' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to push - convert a form first.' });
  }
  if (!getEnvVar('DA_LIVE_IMS_TOKEN')) {
    return res.status(400).json({ error: 'DA_LIVE_IMS_TOKEN is not configured on this server.' });
  }
  try {
    const daLive = await pushToDaLive(formPath, rows);
    res.json({ daLive });
  } catch (err) {
    res.status(200).json({ daLiveError: err.message });
  }
});

// Stages a hero-image file the user attached directly in the browser (drag
// or file picker), for a campaign landing page created moments later via
// /api/chat. Only ever holds the bytes in memory, keyed by a one-shot id -
// nothing is uploaded to da.live until the campaign itself is actually
// created (with a real page to nest the image folder under), so attaching
// an image and then not sending the campaign just lets the entry expire
// unused rather than leaving an orphaned upload on the site.
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded.' });
  }
  if (!req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'That file is not an image.' });
  }
  sweepPendingHeroImages();
  const imageId = crypto.randomUUID();
  pendingHeroImages.set(imageId, {
    buffer: req.file.buffer, mimeType: req.file.mimetype, fileName: req.file.originalname, uploadedAt: Date.now(),
  });
  res.json({ imageId, fileName: req.file.originalname });
});

// ---- Conversational form creation ----
// Same output contract as /api/convert ({ csv, report, rows }) so the
// existing results UI (stats, review list, preview table, copy/download
// buttons) works unchanged regardless of which path produced the data.

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const VALID_FIELD_TYPES = Object.keys(TYPE_MAP);

const CHAT_SYSTEM_PROMPT = `You help someone build a new Adaptive Forms-style form through plain conversation, for later conversion into an EDS da.live sheet by this same tool's converter.

Ask short clarifying questions until you have enough to build a complete form, INCLUDING what da.live path the form should live at (e.g. "broncos/signup" - a brand-slug/form-name pair; ask if not given, don't guess a real brand's slug). formPath must be ONLY that brand-slug/form-name pair - the site's org and repo are already fixed on the server and must never appear in formPath, even if the user's own message happens to mention them (e.g. if asked for "da.live /edsformspoc/chiefs/ai-form", the correct formPath is just "chiefs/ai-form", not "edsformspoc/chiefs/ai-form"). Reasonably default anything else not specified (e.g. a plausible redirect path) rather than asking about everything. Once ready, call emit_af_model with the complete field tree - do not describe it in prose first.

## Shape to produce (matches this tool's actual AF model input format)
A top-level "items" object, keyed by a short field id, each value an object with:
- Field id (the object's key): MUST be all-lowercase, no camelCase (e.g. "textalerts", not "textAlerts"). The renderer's rule engine looks up a changed field by its DOM id, which is always auto-lowercased, but indexes rule dependencies by this exact key - a mixed-case id silently breaks any OTHER field's rule that depends on it (the dependent field's Visible/Required Expression never re-evaluates when this one changes). This is a real engine limitation, not a style preference - always lowercase, no exceptions.
- fieldType: MUST be exactly one of: ${VALID_FIELD_TYPES.join(', ')}. Nothing else - these are the literal values this tool's converter recognizes; anything else is reported as an unmapped type and blocks a clean conversion.
- label: { value: "the visible label text" }
- required: true/false
- placeholder: for text-like inputs
- enum / enumNames: parallel arrays for select/checkbox-group fields - the submitted values and their displayed names. NEVER truncate these with "..." - always the complete list, however long (e.g. all ~248 ISO3 country codes, or all 32 NFL teams).
  - For an NFL favorite-team field, use nickname-based Options (Cardinals, Falcons, Ravens, ...) NOT city abbreviations (not ARI/ATL/BAL) - this project's team-highlight feature looks teams up by nickname and silently breaks on abbreviations.
- default: default value.
- description: helper/tooltip-style text shown under or near the field.
- richText: true if label or value contains HTML that should render as HTML.
- rules: { requiredExpression, visibleExpression, tooltipVisible } - plain JS-style boolean expressions using ==, !=, &&, ||, and single-quoted string literals, e.g. "country == 'USA'" or "country != 'USA' && country != 'CAN' && country != 'MEX'". This tool's own converter translates that into the sheet's Excel-style formula syntax automatically - do not hand-write the Excel style yourself, and do not use double quotes here.
  - The renderer's expression parser has NO boolean literal - bare true/false are parsed as (nonexistent, always-undefined) field references, not booleans. NEVER write a rule like "someCheckbox == true" - it silently does the wrong thing (evaluates as a coincidental comparison of two undefineds, not a real checked/unchecked check). To make another field's visibility/required state depend on a checkbox being checked, compare against the string the checkbox actually holds when checked: 'on' by default (e.g. "textalerts == 'on'"), or whatever you set as that checkbox field's own "default" if you gave it one.
- properties: { "fd:layout": { gridColumn: "col-6" } } to sit two fields side by side (e.g. first/last name), { "fd:customType": "team-highlight" } on a favorite-team dropdown if wanted, { "fd:redirectUrl": "/brand/thank-you" } on the submit button.
- A submit button is fieldType "submit" with label.value as the button text.
- A plain-text row is fieldType "plain-text" with its content in "value" (often no label).

## Launching a full campaign (landing page + form), not just a bare form
If the user asks for a "campaign", "landing page", or otherwise clearly wants a page around the form (not just the form itself), also fill in pageHeadline (and optionally pageDescription) on the same emit_af_model call. This pushes a second page alongside the form sheet, at "<formPath>-page" (e.g. formPath "chiefs/spring-signup" -> page at "chiefs/spring-signup-page"), reusing this site's own existing landing-page pattern - the page is just a hero (if a heroImageUrl was given), the form block, and a Title/Description, and the site's brand-banner mechanism (logo, headline, description, brand color/font) renders on top of that automatically, exactly like this project's other hand-built landing pages. Do NOT invent marketing copy blocks or new page sections beyond the hero - the brand banner already covers the rest, already proven to render correctly for any brand. If the user only asked for a form (no mention of a page/campaign/landing page), leave pageHeadline out entirely - don't create a page nobody asked for.

### Hero photo (optional, only alongside pageHeadline)
Only include heroImageUrl when the user gives you an actual image URL, or clearly says to use one they'll provide - NEVER invent, guess, or hallucinate an image URL yourself; there is no image generation available here, and a fake URL will just fail to load. If they want a landing page but haven't given an image, either ask for one or proceed without heroImageUrl - a page with no hero still works fine (just headline/description via the brand banner, same as before this capability existed).

When ready, call emit_af_model. If it reports problems, fix them and call it again - never leave the user with a sheet you already know is broken.`;

const CHAT_TOOL = {
  name: 'emit_af_model',
  description: 'Emit the complete AF-model item tree for the form once enough information has been gathered through conversation.',
  input_schema: {
    type: 'object',
    properties: {
      formPath: {
        type: 'string',
        description: 'da.live path for the new form, e.g. "broncos/signup" - no leading/trailing slash.',
      },
      items: {
        type: 'object',
        description: 'Keyed by field id. See system prompt for the shape of each value.',
        additionalProperties: true,
      },
      pageHeadline: {
        type: 'string',
        description: 'OPTIONAL. Only include this when the user wants a full landing page for the form (a "campaign"), not just the bare form itself. The page\'s main headline - becomes that page\'s Title metadata, which the site\'s own brand-banner already renders automatically (logo + headline + description), same as this project\'s existing hand-built landing pages. Omit entirely for a bare-form request - no page is created unless this is present.',
      },
      pageDescription: {
        type: 'string',
        description: 'OPTIONAL, only meaningful alongside pageHeadline. A short supporting line under the headline (becomes that page\'s Description metadata).',
      },
      heroImageUrl: {
        type: 'string',
        description: 'OPTIONAL, only meaningful alongside pageHeadline. A real, fetchable URL to a photo for the landing page\'s hero section. Only set this when the user actually supplied/referenced a real image URL - never invent one; there is no image generation available.',
      },
    },
    required: ['formPath', 'items'],
  },
};

// ---- Direct da.live push (optional - falls back to CSV-only if unset) ----
const DA_ORG = process.env.DA_LIVE_ORG || 'raviprashanth885';
const DA_REPO = process.env.DA_LIVE_REPO || 'edsformspoc';
const DA_MCP_URL = 'https://mcp.adobeaemcloud.com/adobe/mcp/da';

function buildSheetJson(rows) {
  return JSON.stringify({
    total: rows.length,
    limit: rows.length,
    offset: 0,
    data: rows,
    ':colWidths': SHEET_COLUMNS.map(() => 50),
    ':sheetname': 'data',
    ':type': 'sheet',
  });
}

// Strip a redundant org/repo (or org, or repo) prefix if the model (echoing
// how the user phrased the request, e.g. "at da.live /edsformspoc/chiefs/")
// included it - org/repo are already fixed above, so a literal match here
// would otherwise duplicate into paths like edsformspoc/chiefs/... nested a
// second time under the real chiefs/ folder. Shared by both push paths below.
function resolveSheetPath(formPath) {
  let cleanPath = formPath.replace(/^\/|\/$/g, '');
  const redundantPrefixes = [`${DA_ORG}/${DA_REPO}/`, `${DA_REPO}/`, `${DA_ORG}/`];
  // eslint-disable-next-line no-restricted-syntax
  for (const prefix of redundantPrefixes) {
    if (cleanPath.startsWith(prefix)) {
      cleanPath = cleanPath.slice(prefix.length);
      break;
    }
  }
  return `${cleanPath}/form.json`;
}

// Calls da_create_source directly against the DA MCP server - no LLM involved
// at all. For a sheet push we already have the exact JSON deterministically
// (via convert()/toCsv() above); for a page push, the HTML is built by
// buildCampaignPageHtml(), equally deterministic. Either way there's nothing
// for a model to decide here; routing a fixed, known tool call through an
// Anthropic completion (see pushContentViaClaude below) only ever cost
// tokens and latency for Claude to retype content we already had, with no
// upside. This is now the primary path; that one stays only as an automatic
// fallback. Generic over content/contentType so both the sheet push and the
// campaign-page push share one implementation instead of two near-identical
// copies drifting apart over time.
async function pushContentDirect(targetPath, contentType, content) {
  const transport = new StreamableHTTPClientTransport(
    new URL(DA_MCP_URL),
    { requestInit: { headers: { Authorization: `Bearer ${getEnvVar('DA_LIVE_IMS_TOKEN')}` } } },
  );
  const client = new McpClient({ name: 'af-eds-accelerator', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'da_create_source',
      arguments: {
        org: DA_ORG, repo: DA_REPO, path: targetPath, contentType, content,
      },
    });
    const textBlock = (result.content || []).find((b) => b.type === 'text');
    let parsed = {};
    try {
      parsed = textBlock ? JSON.parse(textBlock.text) : {};
    } catch (e) {
      parsed = { raw: textBlock && textBlock.text };
    }
    if (result.isError) {
      throw new Error(`da_create_source failed: ${textBlock ? textBlock.text : 'unknown error'}`);
    }
    return { targetPath, ...parsed };
  } finally {
    await client.close().catch(() => {});
  }
}

// Fallback only - kept working exactly as before in case the direct MCP path
// above ever fails (network issue, an MCP-server-side change, etc.), so a
// regression there degrades to "slower and more tokens" rather than "the
// demo's push breaks." Claude's only job here is to call da_create_source
// with content we already generated and trust - it never freehands the
// da.live content itself, so this can't reintroduce the formatting bugs
// that shape took several rounds to track down by hand.
async function pushContentViaClaude(targetPath, contentType, content) {
  // max_tokens must cover the tool call's own generated output, which
  // includes reproducing the whole content verbatim as the tool's input - a
  // form with full country/team option lists alone runs to several thousand
  // tokens (measured: the real Chiefs sheet is ~3,200 just for content), so
  // a small cap here silently drops the tool call entirely with no error,
  // which is exactly what broke this the first time.
  const response = await anthropic.beta.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 16000,
    betas: ['mcp-client-2025-11-20'],
    mcp_servers: [{
      type: 'url',
      url: DA_MCP_URL,
      name: 'da-live',
      authorization_token: getEnvVar('DA_LIVE_IMS_TOKEN'),
    }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'da-live' }],
    messages: [{
      role: 'user',
      content: `Call da_create_source with org="${DA_ORG}", repo="${DA_REPO}", path="${targetPath}", contentType="${contentType}", and content set to exactly this string (do not alter it):\n\n${content}`,
    }],
  });

  const mcpResult = response.content.find((b) => b.type === 'mcp_tool_result');
  if (!mcpResult) {
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    throw new Error(`da.live push did not complete: ${text || 'no tool call made'}`);
  }
  // content is an array of blocks (per Anthropic's MCP tool result shape),
  // typically one text block whose text is da_create_source's own JSON reply.
  const textBlock = (mcpResult.content || []).find((b) => b.type === 'text');
  let parsed = {};
  try {
    parsed = textBlock ? JSON.parse(textBlock.text) : {};
  } catch (e) {
    parsed = { raw: textBlock && textBlock.text };
  }
  if (mcpResult.is_error) {
    throw new Error(`da_create_source failed: ${textBlock ? textBlock.text : 'unknown error'}`);
  }
  return { targetPath, ...parsed };
}

async function pushContent(targetPath, contentType, content) {
  try {
    const result = await pushContentDirect(targetPath, contentType, content);
    console.log(`[accelerator] Pushed ${targetPath} via direct MCP (no LLM tokens spent on the push).`);
    return result;
  } catch (directErr) {
    console.error('[accelerator] Direct MCP push failed, falling back to Claude-mediated push:', directErr.message);
    const result = await pushContentViaClaude(targetPath, contentType, content);
    console.log(`[accelerator] Pushed ${targetPath} via Claude-mediated fallback.`);
    return result;
  }
}

async function pushToDaLive(formPath, rows) {
  const sheetPath = resolveSheetPath(formPath);
  const result = await pushContent(sheetPath, 'application/json', buildSheetJson(rows));
  return { sheetPath, ...result };
}

// Landing-page half of "launch a campaign in minutes": reuses the site's own
// existing, already-working page template - a form block pointed at the
// sheet, plus a page Metadata block (Title/Description) so the site's own
// decorateBrandBanner() (scripts.js) renders the headline/description/logo
// banner automatically, exactly like every hand-authored landing page this
// project already has (chiefs/fan-alerts-page, chiefs/signup). No hero
// images, no bespoke marketing-copy blocks, no new CSS - 100% reuse of
// mechanisms that already render correctly for any brand.
function resolvePagePath(formPath) {
  const cleanPath = formPath.replace(/^\/|\/$/g, '');
  const redundantPrefixes = [`${DA_ORG}/${DA_REPO}/`, `${DA_REPO}/`, `${DA_ORG}/`];
  // eslint-disable-next-line no-restricted-syntax
  for (const prefix of redundantPrefixes) {
    if (cleanPath.startsWith(prefix)) {
      return `${cleanPath.slice(prefix.length)}-page`;
    }
  }
  return `${cleanPath}-page`;
}

// Downloads a real photo from a URL the user supplied (or that the model
// only includes when the user actually gave/asked for one - it can't
// generate or verify a real image exists) and mirrors it into this site's
// own media storage via da_upload_media, exactly the same mechanism da.live
// itself uses when someone drags an image into the WYSIWYG editor. This
// matters: a hero <picture> pointed straight at an arbitrary external URL,
// or at da.live's own private content.da.live storage, either breaks
// hotlinking/CORS or 401s for anonymous visitors (both diagnosed live on
// this project already) - only a real site-mirrored media asset renders
// reliably for every visitor. Uses the MCP server's own documented
// convention for a page-scoped image: a dot-prefixed folder named after the
// page, sibling to the page file itself.
// Core: uploads bytes already in hand (from a URL fetch below, or straight
// from a browser file attachment in /api/upload-image) to the page-scoped
// folder and returns the page-relative reference to use in the hero
// <picture>. Split out from the URL-fetching wrapper below so a direct file
// attachment can skip the fetch step entirely and hand its bytes straight
// here.
async function uploadMediaToPage(pagePath, buffer, mimeType) {
  const transport = new StreamableHTTPClientTransport(
    new URL(DA_MCP_URL),
    { requestInit: { headers: { Authorization: `Bearer ${getEnvVar('DA_LIVE_IMS_TOKEN')}` } } },
  );
  const client = new McpClient({ name: 'af-eds-accelerator', version: '1.0.0' });
  try {
    const ext = (mimeType.split('/')[1] || 'jpg').split(';')[0];
    const fileName = `hero.${ext}`;
    const pageFolder = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')) : '';
    const pageName = pagePath.includes('/') ? pagePath.slice(pagePath.lastIndexOf('/') + 1) : pagePath;
    const imagePath = `${pageFolder ? `${pageFolder}/` : ''}.${pageName}/${fileName}`;

    await client.connect(transport);
    const result = await client.callTool({
      name: 'da_upload_media',
      arguments: {
        org: DA_ORG, repo: DA_REPO, path: imagePath, base64Data: buffer.toString('base64'), mimeType, fileName,
      },
    });
    if (result.isError) {
      const textBlock = (result.content || []).find((b) => b.type === 'text');
      throw new Error(`da_upload_media failed: ${textBlock ? textBlock.text : 'unknown error'}`);
    }
    // Relative to the page itself, matching how every other image reference
    // in this project's pages already resolves (./media_xyz...) - resolved
    // against the page's own URL at render time, not the org/repo root.
    return `./.${pageName}/${fileName}`;
  } finally {
    await client.close().catch(() => {});
  }
}

async function uploadHeroImageFromUrl(pagePath, imageUrl) {
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`Could not fetch hero image (${imgResp.status}) from ${imageUrl}`);
  const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await imgResp.arrayBuffer());
  return uploadMediaToPage(pagePath, buffer, mimeType);
}

// In-memory holding area for a hero image the user attached as a file in
// the browser (not a URL) - /api/upload-image stores the raw bytes here and
// hands back just an id, so the actual campaign-creation call
// (/api/chat) can reference it without re-uploading or round-tripping
// through a public URL. Entries are one-shot (deleted once used) and swept
// after an hour so an attached-but-never-sent image doesn't leak memory
// indefinitely.
const pendingHeroImages = new Map();
const PENDING_IMAGE_TTL_MS = 60 * 60 * 1000;
function sweepPendingHeroImages() {
  const cutoff = Date.now() - PENDING_IMAGE_TTL_MS;
  pendingHeroImages.forEach((entry, id) => {
    if (entry.uploadedAt < cutoff) pendingHeroImages.delete(id);
  });
}

function buildCampaignPageHtml({
  headline, description, sheetPath, formTitle, heroImagePath,
}) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // The form block's decorate() passes this <a>'s full .href straight to
  // fetchForm() (form.js) - it must keep the trailing /form.json, or
  // fetchForm sees no ".json" in the path and instead rewrites it to the
  // AEM JCR content-path convention, 404ing on a da.live sheet like this.
  // Hero markup (picture-in-h1, no explicit alt) intentionally matches this
  // project's other hand-authored hero sections byte-for-byte - that's the
  // exact shape blocks/hero/hero.css already styles (background picture
  // behind the text via a negative z-index), so this needs zero new CSS.
  const heroBlock = heroImagePath
    ? `<div class="hero"><div><div><h1><picture><source srcset="${heroImagePath}"><source srcset="${heroImagePath}" media="(min-width: 600px)"><img src="${heroImagePath}" loading="lazy"></picture></h1></div></div></div>`
    : '';
  return `<body>
  <header></header>
  <main>
    <div>
      ${heroBlock}
      <div class="form">
        <div>
          <div><a href="/${sheetPath}">${esc(formTitle || 'Sign Up')}</a></div>
        </div>
      </div>
    </div>
    <div>
      <div class="metadata">
        <div><div><p>Title</p></div><div><p>${esc(headline)}</p></div></div>
        <div><div><p>Description</p></div><div><p>${esc(description)}</p></div></div>
      </div>
    </div>
  </main>
  <footer></footer>
</body>`;
}

async function pushCampaignPage(formPath, {
  headline, description, heroImageUrl, pendingImageId,
}, sheetPath, formTitle) {
  const pagePath = resolvePagePath(formPath);

  let heroImagePath;
  let heroImageError;
  // A directly-attached file (pendingImageId, from /api/upload-image) takes
  // priority over a URL the model may have also picked up from the chat
  // text - it's the more explicit, already-in-hand signal of what the user
  // actually wants as the hero photo.
  const pending = pendingImageId ? pendingHeroImages.get(pendingImageId) : null;
  if (pending) {
    try {
      heroImagePath = await uploadMediaToPage(pagePath, pending.buffer, pending.mimeType);
    } catch (imgErr) {
      heroImageError = imgErr.message;
    } finally {
      pendingHeroImages.delete(pendingImageId);
    }
  } else if (heroImageUrl) {
    try {
      heroImagePath = await uploadHeroImageFromUrl(pagePath, heroImageUrl);
    } catch (imgErr) {
      // A bad/unreachable image URL shouldn't block the whole campaign -
      // the page still pushes, just without a hero photo, same "degrade,
      // don't block" philosophy as the direct-push/Claude-fallback pattern
      // above.
      heroImageError = imgErr.message;
    }
  }

  const html = buildCampaignPageHtml({
    headline, description, sheetPath, formTitle, heroImagePath,
  });
  const result = await pushContent(pagePath, 'text/html', html);
  return {
    pagePath, ...result, ...(heroImageError ? { heroImageError } : {}),
  };
}

function findTruncatedEnums(items) {
  const problems = [];
  Object.entries(items || {}).forEach(([key, field]) => {
    ['enum', 'enumNames'].forEach((k) => {
      if (Array.isArray(field[k]) && field[k].some((v) => String(v).includes('...'))) {
        problems.push(`${key}.${k} contains "..." - write out the complete list, never truncate it.`);
      }
    });
  });
  return problems;
}

// Catches two real rendering-time bugs the system prompt warns about, in
// case the model doesn't follow that guidance - both were found live, one
// silently shows a field that should stay hidden (or the reverse), the
// other silently breaks a field's rule from ever re-evaluating. Neither
// produces a converter error, so nothing else would catch them.
function findRuleIssues(items) {
  const problems = [];
  Object.entries(items || {}).forEach(([key, field]) => {
    if (/[A-Z]/.test(key)) {
      problems.push(`Field id "${key}" has uppercase letters - field ids must be all-lowercase (e.g. "${key.toLowerCase()}"), or any other field's rule that depends on it will silently never re-evaluate when it changes.`);
    }
    const rules = field.rules || {};
    ['requiredExpression', 'visibleExpression', 'tooltipVisible'].forEach((prop) => {
      const expr = rules[prop];
      if (typeof expr === 'string' && /==\s*(true|false)\b|\b(true|false)\s*==/.test(expr)) {
        problems.push(`${key}.rules.${prop} ("${expr}") compares against a bare true/false - this engine has no boolean literal, so that never works. Compare against the checked value instead, e.g. "== 'on'".`);
      }
    });
  });
  return problems;
}

app.post('/api/chat', async (req, res) => {
  if (!anthropic) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY - set it before starting this tool.' });
    return;
  }
  const { messages, pendingImageId } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  try {
    const conversation = [...messages];
    let finalText = '';
    let result = null;

    // Bounded self-correction loop: an unmapped fieldType or a truncated
    // option list gets reported back to the model to fix, rather than ever
    // handing the user a sheet already known to be broken.
    for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: CHAT_SYSTEM_PROMPT,
        tools: [CHAT_TOOL],
        messages: conversation,
      });

      const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'emit_af_model');
      finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (!toolUse) break;

      const afModel = { items: toolUse.input.items };
      const { rows, report } = convert(afModel);
      const truncationProblems = findTruncatedEnums(afModel.items);
      const ruleProblems = findRuleIssues(afModel.items);
      const problems = [
        ...report.unmappedFieldTypes.map((u) => `${u.key}: "${u.fieldType}" is not a valid fieldType. Must be one of: ${VALID_FIELD_TYPES.join(', ')}.`),
        ...truncationProblems,
        ...ruleProblems,
      ];
      if (!toolUse.input.formPath) problems.push('formPath is required - ask the user where in da.live this form should live.');

      conversation.push({ role: 'assistant', content: response.content });

      if (problems.length === 0) {
        const csv = toCsv(rows);
        fs.writeFileSync(path.join(OUTPUT_DIR, 'chat-generated.csv'), csv);
        result = {
          csv, report, rows, savedAs: 'output/chat-generated.csv', formPath: toolUse.input.formPath,
        };

        // Push directly to da.live when configured - falls back to the
        // existing copy/download-only flow if the token isn't set, so this
        // never blocks the tool from working without it.
        if (getEnvVar('DA_LIVE_IMS_TOKEN')) {
          try {
            // eslint-disable-next-line no-await-in-loop
            result.daLive = await pushToDaLive(toolUse.input.formPath, rows);
          } catch (pushErr) {
            result.daLiveError = pushErr.message;
          }

          // Landing page is entirely opt-in - only pushed when the model
          // included pageHeadline (i.e. the user actually asked for a
          // campaign/landing page, not just a bare form). A bare-form
          // request never touches this code path at all.
          if (result.daLive && toolUse.input.pageHeadline) {
            try {
              // eslint-disable-next-line no-await-in-loop
              result.page = await pushCampaignPage(
                toolUse.input.formPath,
                {
                  headline: toolUse.input.pageHeadline,
                  description: toolUse.input.pageDescription,
                  heroImageUrl: toolUse.input.heroImageUrl,
                  pendingImageId,
                },
                result.daLive.sheetPath,
                toolUse.input.pageHeadline,
              );
            } catch (pageErr) {
              result.pageError = pageErr.message;
            }
          }
        }
        break;
      }

      conversation.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Validation failed, fix and call emit_af_model again:\n${problems.join('\n')}`,
          is_error: true,
        }],
      });
    }

    res.json({
      reply: finalText || (result ? 'Here’s the sheet.' : 'Ran into trouble generating a valid sheet - see server logs.'),
      ...result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('-----------------------------------------------------');
  console.log('  exl  |  Adaptive Forms to EDS Forms Accelerator');
  console.log(`         http://localhost:${PORT}`);
  console.log('-----------------------------------------------------');
});
