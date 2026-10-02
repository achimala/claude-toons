"""Draws a scene's frames (from scripts/frames.ts on stdin) as an animated GIF.

    bun scripts/frames.ts 3 | python3 scripts/gif.py out.gif
"""
import base64, json, struct, sys
from PIL import Image, ImageDraw, ImageFont

CLEAR = 0x01000000
CW, CH = 10, 20
BACK = (24, 24, 28)
FORE = (220, 220, 220)

def main():
    data = json.load(sys.stdin)
    out = sys.argv[1]
    cols, rows, fps = data['cols'], data['rows'], data['fps']
    mono = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 17)
    symbols = ImageFont.truetype('/System/Library/Fonts/Apple Symbols.ttf', 17)
    cache = {}
    def font_for(ch):
        if ch not in cache:
            # Menlo lacks braille and a few shapes: Apple Symbols has them.
            cache[ch] = mono if mono.getmask(ch).getbbox() or ch == ' ' else symbols
        return cache[ch]
    title_h = 44
    W, H = cols * CW, rows * CH + title_h
    images = []
    for cells in data['frames']:
        raw = base64.b64decode(cells)
        words = struct.unpack('<%dI' % (len(raw) // 4), raw)
        im = Image.new('RGB', (W, H), BACK)
        d = ImageDraw.Draw(im)
        d.text((8, 4), data['title'], fill=(255, 255, 255), font=mono)
        d.text((8, 24), data['concept'][:cols - 2], fill=(150, 150, 150), font=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 13))
        for row in range(rows):
            for col in range(cols):
                at = (row * cols + col) * 3
                ch, fg, bg = words[at], words[at + 1], words[at + 2]
                x, y = col * CW, title_h + row * CH
                if bg != CLEAR:
                    d.rectangle([x, y, x + CW - 1, y + CH - 1], fill=((bg >> 16) & 255, (bg >> 8) & 255, bg & 255))
                c = chr(ch) if ch else ' '
                if c != ' ':
                    color = FORE if fg == CLEAR else ((fg >> 16) & 255, (fg >> 8) & 255, fg & 255)
                    if c in '█▀▄▌▐▖▗▘▙▚▛▜▝▞▟':
                        # Blocks as exact rectangles, so pixel art has no seams.
                        q = {'█': (1,1,1,1), '▀': (1,1,0,0), '▄': (0,0,1,1), '▌': (1,0,1,0), '▐': (0,1,0,1),
                             '▖': (0,0,1,0), '▗': (0,0,0,1), '▘': (1,0,0,0), '▙': (1,0,1,1), '▚': (1,0,0,1),
                             '▛': (1,1,1,0), '▜': (1,1,0,1), '▝': (0,1,0,0), '▞': (0,1,1,0), '▟': (0,1,1,1)}[c]
                        hw, hh = CW // 2, CH // 2
                        for i, (qx, qy) in enumerate([(0, 0), (hw, 0), (0, hh), (hw, hh)]):
                            if q[i]:
                                d.rectangle([x + qx, y + qy, x + qx + hw - 1, y + qy + hh - 1], fill=color)
                    else:
                        d.text((x, y + 1), c, fill=color, font=font_for(c))
        images.append(im.quantize(colors=256, method=Image.Quantize.FASTOCTREE))
    images[0].save(out, save_all=True, append_images=images[1:], duration=int(1000 / fps), loop=0, optimize=False)
    print(f'{out}: {len(images)} frames, {W}x{H}, error={data.get("error")}')

main()
