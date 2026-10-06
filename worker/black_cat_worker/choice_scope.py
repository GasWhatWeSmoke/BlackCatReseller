"""Bind reviewed values to the menu opened by a field, never the whole page."""
import json
from time import monotonic

SCOPE_TIMEOUT_MS = 15000
_POPUPS = '[role="listbox"], [role="menu"], [role="dialog"], dialog'


def _visible(locator):
    return locator.filter(visible=True)


def _check_scope(scope, trigger, label):
    handle = trigger.element_handle()
    try:
        if handle is None or scope.evaluate('''(node, trigger) =>
            node === document.body || node === document.documentElement || node.contains(trigger)''', handle):
            raise ValueError(f'{label} choices could not be verified separately from the form')
    finally:
        if handle is not None:
            handle.dispose()
    dialog = scope.locator('xpath=ancestor-or-self::*[self::dialog or @role="dialog"][1]')
    if dialog.count() != 1 or not dialog.is_visible():
        return scope, None
    handle = trigger.element_handle()
    try:
        # A dialog containing the original field is the editor, not its picker.
        return scope, None if handle is None or dialog.evaluate('(node, trigger) => node.contains(trigger)', handle) else dialog
    finally:
        if handle is not None:
            handle.dispose()


def opened_choices(page, trigger, activate, label, native_menu=None, adjacent_panel=False):
    """Use an explicit link, an owned native menu, or a newly opened unique panel.

    An explicitly supported adjacent container handles native non-ARIA dropdowns. Existing
    unrelated dialogs/listboxes and page-level buttons are never fallback scopes.
    """
    page = page.page if hasattr(page, 'page') else page
    before = _visible(page.locator(_POPUPS)).element_handles()
    try:
        adjacent = trigger.locator('xpath=following-sibling::*[1]')
        adjacent_was_hidden = (adjacent_panel and adjacent.count() == 1 and not adjacent.is_visible()
                               and adjacent.evaluate("node => ['DIV','UL','OL','DIALOG'].includes(node.tagName)"))
        activate()
        deadline = monotonic() + SCOPE_TIMEOUT_MS / 1000
        while True:
            controlled = (trigger.get_attribute('aria-controls') or '').split()
            if len(controlled) > 1:
                raise ValueError(f'{label} choice container is ambiguous')
            native_count = native_menu.count() if native_menu is not None else 0
            if native_count > 1:
                raise ValueError(f'{label} choice container is ambiguous')
            owned = native_menu if native_count == 1 else page.locator('[id=' + json.dumps(controlled[0]) + ']') if controlled else None
            if owned is not None:
                if owned.count() > 1:
                    raise ValueError(f'{label} choice container is ambiguous')
                if owned.count() == 1 and owned.is_visible():
                    return _check_scope(owned, trigger, label)
                if trigger.get_attribute('aria-expanded') == 'false':
                    trigger.click()
            elif adjacent_was_hidden and adjacent.count() == 1 and adjacent.is_visible():
                return _check_scope(adjacent, trigger, label)
            else:
                candidates = _visible(page.locator(_POPUPS))
                fresh = [candidates.nth(index) for index in range(candidates.count())
                         if not candidates.nth(index).evaluate('(node, previous) => previous.includes(node)', before)]
                # A picker dialog may contain several size groups and its Done
                # control. Keep that one owner; separate new popups are ambiguous.
                handles = [candidate.element_handle() for candidate in fresh]
                try:
                    owners = [candidate for candidate in fresh if not candidate.evaluate(
                        '(node, opened) => opened.some(other => other && other !== node && other.contains(node))', handles)]
                finally:
                    for handle in handles:
                        if handle is not None:
                            handle.dispose()
                if len(owners) == 1:
                    return _check_scope(owners[0], trigger, label)
                if len(owners) > 1:
                    raise ValueError(f'{label} choice container is ambiguous')
            if monotonic() >= deadline:
                raise ValueError(f'{label} choice container could not be verified')
            page.wait_for_timeout(100)
    finally:
        for handle in before:
            handle.dispose()
