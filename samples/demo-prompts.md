# Demo prompts

## Recommended for live demos

Inline thank-you + URL-based hero image — no dependency on a thank-you page
being published, no live-upload risk.

```
Launch a campaign for the Seahawks with a landing page and a signup form at seahawks/kickoff-party. Headline: "Join the 12s for Kickoff" with description "Get exclusive access to our season kickoff celebration." Use this photo as the hero image: https://main--edsformspoc--raviprashanth885.aem.page/seahawks/media_1c4fb28ed8e1a7ace32e2c5d256d290dd58109f0e.png?width=1200&format=png&optimize=medium. Fields: First Name and Last Name side by side (both required), Email (required), a checkbox "Text me event updates". Submit button says "Count Me In". No redirect - inline thank-you message instead.
```

## Alternates

With a redirect instead of the inline thank-you (requires `seahawks/thank-you`
to be published to `.live`, not just preview):

```
Launch a campaign for the Seahawks with a landing page and a signup form at seahawks/kickoff-party. Headline: "Join the 12s for Kickoff" with description "Get exclusive access to our season kickoff celebration." Fields: First Name and Last Name side by side (both required), Email (required), a checkbox "Text me event updates". Submit button says "Count Me In". Redirect to /seahawks/thank-you on submit.
```

Chiefs version, for variety:

```
Launch a campaign for the Chiefs with a landing page and a signup form at chiefs/tailgate-tour. Headline: "Join the Chiefs Tailgate Tour" with description "Sign up for exclusive tailgate access at every home game." Fields: First Name and Last Name side by side (both required), Email (required), a checkbox "Text me tailgate updates". Submit button says "I'm In". No redirect - inline thank-you message instead.
```

Bare form (no landing page) - the original working demo prompt:

```
Create a fan signup form for the Chiefs at da.live /chiefs/fan-alerts. Fields: First Name and Last Name side by side (both required), Email (required), Favorite NFL Team (required dropdown, use the team-highlight custom type), a checkbox "Text me game-day alerts", and — only if that's checked — a required Phone Number field. Redirect to /chiefs/thank-you on submit.
```

## Notes

- Use an existing branded site (Chiefs or Seahawks) — both have a working
  `metadata.json` entry, so the brand banner (logo/colors/font) renders
  correctly. A brand-new/made-up brand won't show a banner.
- To attach a hero photo live instead of a URL: drag the image file into the
  chat before sending the campaign prompt. Rehearse this once beforehand if
  you want to demo it live - predictable URL-based version above is safer
  for a first attempt in front of a client.
