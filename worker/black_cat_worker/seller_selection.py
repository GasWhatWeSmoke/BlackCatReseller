"""Select native checkbox labels without bypassing their click handling."""


def check_listing_checkbox(checkbox):
    from playwright.sync_api import expect
    expect(checkbox).to_have_count(1)
    expect(checkbox).to_be_enabled()
    if checkbox.is_checked(): return
    # Etsy covers its input with a for= label; Mercari covers a nested input
    # with a styled square. The browser's labels association identifies the
    # actual click target without guessing CSS classes or forcing a click.
    handle = checkbox.evaluate_handle('e=>e.labels?.length===1?e.labels[0]:null')
    try:
        label = handle.as_element()
        if label:
            checkbox.evaluate("e=>e.scrollIntoView({block:'center',inline:'nearest'})")
            bounds = label.bounding_box()
            if bounds and bounds['width'] and bounds['height']:
                label.click()
            else:
                # Etsy's label itself is 0x0; its ::before paints the clickable
                # box over the input. Click that point inside the shared wrapper
                # so normal label activation and marketplace handlers still run.
                position = checkbox.evaluate('''e=>{
                  const p=e.parentElement,l=e.labels[0];
                  if(!p.contains(l)||p.querySelectorAll('input').length!==1||p.querySelector('button,a,select,textarea'))return null;
                  const r=e.getBoundingClientRect(),b=p.getBoundingClientRect();
                  return r.width&&r.height?{x:r.x-b.x+r.width/2,y:r.y-b.y+r.height/2}:null;
                }''')
                if not position: raise ValueError('The listing checkbox label has no verified click target')
                checkbox.locator('..').click(position=position)
        else:
            checkbox.check()
    finally:
        handle.dispose()
    expect(checkbox).to_be_checked()
