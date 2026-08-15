import base64, json, sys
import numpy as np
from PIL import Image
import PIL

rng = np.random.default_rng(1234)

def grad(w, h, ch):
    a = np.zeros((h, w, ch), dtype=np.uint8)
    for c in range(ch):
        yy, xx = np.mgrid[0:h, 0:w]
        a[:, :, c] = (xx * 3 + yy * 5 + c * 41) % 256
    return a

def noise(w, h, ch):
    return rng.integers(0, 256, size=(h, w, ch), dtype=np.uint8)

cases = []
def add(name, arr, outw, outh):
    h, w = arr.shape[0], arr.shape[1]
    ch = arr.shape[2]
    mode = {1: 'L', 3: 'RGB', 4: 'RGBA'}[ch]
    img = Image.fromarray(arr.squeeze() if ch == 1 else arr, mode=mode)
    out = img.resize((outw, outh), Image.BICUBIC)
    ob = np.asarray(out)
    if ch == 1:
        ob = ob.reshape(outh, outw, 1)
    cases.append({
        'name': name, 'mode': mode,
        'inW': w, 'inH': h, 'outW': outw, 'outH': outh,
        'channels': ch,
        'pillow_version': PIL.__version__,
        'input_b64': base64.b64encode(arr.tobytes()).decode(),
        'output_b64': base64.b64encode(ob.tobytes()).decode(),
    })

# Production-shaped downscales (shortest edge 440 / 512)
add('prod_down_rgb', noise(1600, 1200, 3), 587, 440)
add('prod_down_512_rgb', noise(1600, 1200, 3), 683, 512)
add('prod_down_rgba', noise(1024, 768, 4), 587, 440)
# Upscales
add('upscale_rgb', noise(200, 150, 3), 587, 440)
add('upscale_big_rgb', grad(64, 48, 3), 512, 700)
add('upscale_gray', noise(100, 80, 1), 440, 352)
# Grayscale downscale
add('gray_down', noise(900, 700, 1), 440, 342)
# Mixed axis: upscale one axis, downscale other
add('mixed_axes', noise(300, 900, 3), 440, 512)
# Extreme downscale (many taps, big negative-lobe accumulation)
add('extreme_down', noise(2000, 2000, 3), 17, 11)
add('to_1x1', noise(555, 333, 3), 1, 1)
# Tiny inputs (xmin clamping, xmax clamping dominate)
add('tiny_up', noise(2, 2, 3), 384, 384)
add('one_px_up', noise(1, 1, 3), 40, 40)
add('tiny_3x5', noise(3, 5, 3), 100, 7)
# Hard-edge content (clipping via clip8 both ends)
edge = np.zeros((64, 64, 3), dtype=np.uint8)
edge[:, 32:, :] = 255
add('step_edge_down', edge, 31, 31)
add('step_edge_up', edge, 200, 129)
# checkerboard extremes
cb = ((np.indices((97, 89)).sum(axis=0) % 2) * 255).astype(np.uint8).reshape(97, 89, 1)
add('checker_gray_down', cb, 33, 47)
add('checker_gray_up', cb, 200, 260)
# same-size identity through Pillow
add('same_size', noise(77, 41, 3), 77, 41)
# one-axis identity (horizontal pass identity, vertical resample)
add('one_axis_same_w', noise(120, 90, 3), 120, 440)
add('one_axis_same_h', noise(120, 90, 3), 440, 90)

json.dump(cases, open(sys.argv[1], 'w'))
print(f'{len(cases)} cases, Pillow {PIL.__version__}')
