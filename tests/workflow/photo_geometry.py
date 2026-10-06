def assert_photo_contained(image):
    image.evaluate('(el)=>el.decode()')
    bounds = image.evaluate('''el => {
      const image = el.getBoundingClientRect(), frame = el.parentElement.getBoundingClientRect();
      return { image: {left:image.left, top:image.top, right:image.right, bottom:image.bottom},
        frame: {left:frame.left, top:frame.top, right:frame.right, bottom:frame.bottom},
        fit: getComputedStyle(el).objectFit };
    }''')
    a, b = bounds['image'], bounds['frame']
    assert bounds['fit'] == 'contain', bounds
    assert a['left'] >= b['left'] - 1 and a['right'] <= b['right'] + 1, bounds
    assert a['top'] >= b['top'] - 1 and a['bottom'] <= b['bottom'] + 1, bounds
    return bounds
