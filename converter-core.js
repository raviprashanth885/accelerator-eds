const TYPE_MAP = {
  "text-input": "text",
  "email": "email",
  "drop-down": "select",
  "date-input": "date-input",
  "checkbox": "checkbox",
  "checkbox-group": "checkbox-group",
  "plain-text": "plain-text",
  "submit": "submit",
  "radio-button": "radio",
  "numeric-input": "number",
  "telephone-input": "tel",
  "file-attachment": "file"
};

const SHEET_COLUMNS = [
  'Name', 'Label', 'Type', 'Mandatory', 'Placeholder', 'Options', 'OptionNames',
  'Required Error Message', 'Required Expression', 'Style', 'Description', 'tooltip',
  'Value', 'richText', 'Tooltip Visible Expression', 'Visible Expression',
  'label.richText', 'Custom Type', 'Redirect URL'
];

function splitTopLevel(expr, operator) {
  const parts = [];
  let depth = 0, current = '', i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && expr.slice(i, i + operator.length) === operator) {
      parts.push(current.trim());
      current = '';
      i += operator.length;
      continue;
    }
    current += ch;
    i++;
  }
  parts.push(current.trim());
  return parts;
}

function translateComparison(expr) {
  return expr.replace(/==/g, '=').replace(/!=/g, '<>').replace(/'/g, '"').trim();
}

function translateExpression(expr) {
  if (!expr) return '';
  let e = expr.trim();
  if (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0, wraps = true;
    for (let i = 0; i < e.length - 1; i++) {
      if (e[i] === '(') depth++;
      if (e[i] === ')') depth--;
      if (depth === 0) { wraps = false; break; }
    }
    if (wraps) e = e.slice(1, -1).trim();
  }
  const orParts = splitTopLevel(e, '||');
  if (orParts.length > 1) return `OR(${orParts.map(translateExpression).join(', ')})`;
  const andParts = splitTopLevel(e, '&&');
  if (andParts.length > 1) return `AND(${andParts.map(translateExpression).join(', ')})`;
  return translateComparison(e);
}

function convert(afModel) {
  const unmappedTypes = [];
  const flaggedRules = [];
  const rows = [];

  function walk(items) {
    for (const key of Object.keys(items || {})) {
      const field = items[key];
      if (field.items) { walk(field.items); continue; }

      const sheetType = TYPE_MAP[field.fieldType];
      if (!sheetType) unmappedTypes.push({ key, fieldType: field.fieldType });

      const rules = field.rules || {};
      if (Object.keys(rules).length) flaggedRules.push({ name: key, rules });

      rows.push({
        Name: key,
        Label: field.label ? field.label.value : '',
        Type: sheetType || `UNMAPPED:${field.fieldType}`,
        Mandatory: field.required ? 'x' : '',
        Placeholder: field.placeholder || '',
        Options: (field.enum || []).join(','),
        OptionNames: (field.enumNames || []).join(','),
        'Required Error Message': (field.errorMessage && Object.values(field.errorMessage)[0]) || '',
        'Required Expression': translateExpression(rules.requiredExpression),
        Style: (field.properties && field.properties['fd:layout'] && field.properties['fd:layout'].gridColumn) || '',
        Description: '',
        tooltip: field.description || '',
        Value: field.value || field.default || '',
        richText: field.richText ? 'true' : '',
        'Tooltip Visible Expression': translateExpression(rules.tooltipVisible),
        'Visible Expression': translateExpression(rules.visibleExpression),
        'label.richText': (field.label && field.label.richText) ? 'true' : '',
        'Custom Type': (field.properties && field.properties['fd:customType']) || '',
        'Redirect URL': (field.properties && field.properties['fd:redirectUrl']) || ''
      });
    }
  }

  walk(afModel.items);

  const report = {
    fieldsConverted: rows.length,
    unmappedFieldTypes: unmappedTypes,
    fieldsWithRules: flaggedRules,
    reviewRequired: unmappedTypes.length > 0 || flaggedRules.length > 0
  };

  return { rows, report };
}

function toCsv(rows) {
  function esc(val) {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const lines = [SHEET_COLUMNS.join(',')];
  for (const row of rows) lines.push(SHEET_COLUMNS.map(c => esc(row[c])).join(','));
  return lines.join('\n');
}

module.exports = { convert, toCsv, SHEET_COLUMNS, TYPE_MAP };
