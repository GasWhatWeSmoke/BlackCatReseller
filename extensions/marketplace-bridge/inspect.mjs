// Passed as a function to chrome.scripting; keep it self-contained. Never read
// cookies, storage, page scripts, hidden fields, login forms or order/customer rows.
export function inspectSellerPage() {
  const visible = (e) => !!e.getClientRects().length && getComputedStyle(e).visibility !== "hidden";
  const clean = (value, limit = 200) => String(value ?? "").replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]").slice(0, limit);
  const path = location.pathname;
  const allowed = ({
    "www.ebay.com": /^\/(sh(?:\/|$)|sl(?:\/|$)|lstng(?:\/|$))/,
    "www.etsy.com": /^\/your\/shops\/[^/]+\/(?:dashboard(?:\/|$)|tools\/listings(?:\/|$)|listing-editor\/create\/?$)/,
    "www.depop.com": /^\/products\/create\/?$/,
    "poshmark.com": /^\/(create-listing|edit-listing)(?:\/|$)/,
    "www.poshmark.com": /^\/(create-listing|edit-listing)(?:\/|$)/,
  })[location.hostname];
  const loginField = [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some(visible);
  if (!allowed?.test(path) || loginField) {
    return { state: "needs_operator", path, message: "Open the seller dashboard or listing editor after finishing sign-in. Login fields are not inspected." };
  }
  const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map((e) => clean(e.textContent)).slice(0, 60);
  if (headings.some((s) => /page.*not found|sign in|log in|verify.*identity|security check|captcha/i.test(s))) {
    return { state: "needs_operator", path, headings, message: "The seller page needs your attention." };
  }
  const formPage = /\/lstng|\/sl\/|\/tools\/listings|\/listing-editor\/create|\/products\/create|\/create-listing|\/edit-listing/.test(path);
  const fields = formPage ? [...document.querySelectorAll('input,textarea,select,button,[role="combobox"],[role="option"],[contenteditable="true"]')]
    .filter((e) => visible(e) || e.type === "file")
    .filter((e) => !['hidden', 'password'].includes(e.type) && !/password|email|phone|token|csrf|verification|security.code/i.test(`${e.name} ${e.id} ${e.autocomplete}`))
    .slice(0, 180) : [];
  const controls = fields.map((e) => ({ tag: e.tagName.toLowerCase(), type: e.type ?? null,
      id: clean(e.id), name: clean(e.name), role: e.getAttribute('role'),
      label: clean(e.getAttribute('aria-label') || [...(e.labels ?? [])].map((l) => l.textContent).join(' ') ||
        (e.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')),
      text: clean(e.tagName === 'BUTTON' || ['option', 'combobox'].includes(e.getAttribute('role')) ? e.textContent : ''),
      value: clean(e.type === 'file' ? '' : e.value, 300),
      checked: ['checkbox', 'radio'].includes(e.type) ? e.checked : undefined,
      disabled: !!e.disabled,
    }));
  // Native select options have no layout boxes until opened. Their parent was
  // already verified visible and safe above; read only labels/values needed to
  // map the listing form, retaining the same bounded report schema.
  for (const field of fields) {
    if (field.tagName !== 'SELECT') continue;
    for (const option of field.options) {
      if (controls.length >= 180) break;
      controls.push({ tag: 'option', type: null, id: clean(field.id), name: clean(field.name), role: null,
        label: clean(option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : ''),
        text: clean(option.textContent), value: clean(option.value, 300), checked: !!option.selected, disabled: !!option.disabled });
    }
  }
  return { state: "seller_page", path, title: clean(document.title), headings, controls };
}
