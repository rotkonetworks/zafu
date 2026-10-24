"""
Chrome Web Store images for zafu: 5 screenshots (1280x800), the small (440x280)
and marquee (1400x560) promo tiles, and the 128px store icon, for the beta and
prod listings. Built from the real screens in ../images/raw (capture.cjs) and
zafu's own art and fonts.

usage (repo root):  python3 docs/cws-listing/tools/compose.py
writes docs/cws-listing/images/{beta,prod}/
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
RAW = os.path.join(HERE, '../images/raw')
FONTS = os.path.join(ROOT, 'packages/ui/fonts')
MEDIA = os.path.join(ROOT, 'apps/extension/public/media')
FAV = os.path.join(ROOT, 'apps/extension/public/favicon')
CHANNEL = None  # 'beta' | 'prod', set per run below
OUT = None
mincho = lambda s: ImageFont.truetype(f'{FONTS}/shippori-mincho-600.woff2', s)
mono = lambda s: ImageFont.truetype(f'{FONTS}/iosevka-term-ss03-regular.woff2', s)
CANVAS = (12, 10, 8); FG_HIGH = (242, 236, 223); MUTED = (148, 138, 121)
GOLD = (244, 183, 40); BORDER = (50, 42, 33)

def seal_path():
    return f'{FAV}/beta/icon128.png' if CHANNEL == 'beta' else f'{FAV}/icon128.png'


def art_bg(size, art, side='left', strength=0.22):
    """canvas with a faded brush-art panel on one side"""
    W, H = size
    bg = Image.new('RGB', size, CANVAS)
    a = Image.open(f'{MEDIA}/onboarding/{art}.webp').convert('RGB')
    scale = H / a.height
    a = a.resize((int(a.width * scale), H), Image.LANCZOS)
    a = Image.blend(Image.new('RGB', a.size, CANVAS), a, strength)
    x = 0 if side == 'left' else W - a.width
    # fade the inner edge into the canvas
    mask = Image.new('L', a.size, 255)
    md = ImageDraw.Draw(mask)
    fade = int(a.width * 0.6)
    for i in range(fade):
        v = int(255 * (1 - i / fade))
        col = a.width - fade + i if side == 'left' else fade - 1 - i
        md.line([(col, 0), (col, H)], fill=v)
    bg.paste(a, (x, 0), mask)
    return bg

def phone(name, h):
    im = Image.open(f'{RAW}/{name}.png').convert('RGB')
    w = int(im.width * h / im.height)
    im = im.resize((w, h), Image.LANCZOS)
    framed = Image.new('RGB', (w + 2, h + 2), BORDER)
    framed.paste(im, (1, 1))
    return framed

def shadowed(base, im, xy):
    sh = Image.new('RGBA', (im.width + 60, im.height + 60), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rectangle([30, 30, 30 + im.width, 30 + im.height], fill=(0, 0, 0, 170))
    sh = sh.filter(ImageFilter.GaussianBlur(18))
    base.paste(sh, (xy[0] - 30 + 8, xy[1] - 30 + 12), sh)
    base.paste(im, xy)

def text_block(d, x, y, kicker, title_lines, body_lines):
    d.text((x, y), kicker, font=mono(20), fill=GOLD)
    y += 52
    for t in title_lines:
        d.text((x, y), t, font=mincho(50), fill=FG_HIGH)
        y += 64
    y += 18
    for b in body_lines:
        d.text((x, y), b, font=mono(18), fill=MUTED)
        y += 30

def shot(fname, art, kicker, title, body, phones):
    W, H = 1280, 800
    img = art_bg((W, H), art, side='left')
    d = ImageDraw.Draw(img)
    text_block(d, 80, 230, kicker, title, body)
    ph = 560
    ims = [phone(p, ph) for p in phones]
    gap = 36
    total = sum(i.width for i in ims) + gap * (len(ims) - 1)
    x = W - 60 - total
    for i, im in enumerate(ims):
        shadowed(img, im, (x, (H - im.height) // 2 + (0 if i == 0 else 24)))
        x += im.width + gap
    seal = Image.open(seal_path()).convert('RGBA').resize((34, 34), Image.LANCZOS)
    img.paste(seal, (80, 70), seal)
    d.text((126, 72), 'zafu', font=mincho(28), fill=FG_HIGH)
    img.convert('RGB').save(os.path.join(OUT, fname), 'PNG')

def build():
    # 1: the welcome page as it is
    w = Image.open(f'{RAW}/welcome-wide.png').convert('RGB').resize((1280, 800), Image.LANCZOS)
    w.save(os.path.join(OUT, '1-welcome.png'), 'PNG')

    shot('2-wallet.png', 'bamboo', 'zcash · penumbra',
         ['shielded by', 'default.'],
         ['private balances and sends.', 'a fresh address per sender.', 'proofs built on your computer.'],
         ['home', 'receive'])
    shot('3-people.png', 'castle', 'people',
         ['private', 'chat.'],
         ['your card, your seal, your contacts.', 'messages ride the relay for free,', 'or a shielded memo on chain.'],
         ['identity', 'inbox'])
    shot('4-zigner.png', 'enso', 'cold signing',
         ['keys off', 'this computer.'],
         ['pair zigner, the air-gapped signer.', 'every transaction is checked and', 'signed on your phone, by qr.'],
         ['zigner', 'tools'])
    shot('5-privacy.png', 'samurai', 'privacy',
         ['asks before', 'it connects.'],
         ['a new server is never contacted', 'without your yes.', 'you choose who sees you online.'],
         ['settings', 'swap'])

    # promo tiles
    def tile(size, fname, title_size, tag_size, tag=True):
        W, H = size
        img = Image.new('RGB', size, CANVAS)
        a = Image.open(f'{MEDIA}/welcome.webp').convert('RGB')
        scale = H / a.height
        a = a.resize((int(a.width * scale), H), Image.LANCZOS)
        aw = min(a.width, int(W * 0.58))
        a = a.crop((0, 0, aw, H))
        mask = Image.new('L', a.size, 255); md = ImageDraw.Draw(mask)
        fade = int(aw * 0.45)
        for i in range(fade):
            md.line([(aw - fade + i, 0), (aw - fade + i, H)], fill=int(255 * (1 - i / fade)))
        img.paste(a, (0, 0), mask)
        d = ImageDraw.Draw(img)
        x = int(W * 0.56)
        seal_s = int(title_size * 0.95)
        seal = Image.open(seal_path()).convert('RGBA').resize((seal_s, seal_s), Image.LANCZOS)
        ty = H // 2 - title_size + (0 if tag else title_size // 2)
        img.paste(seal, (x, ty + int(title_size * 0.12)), seal)
        d.text((x + seal_s + int(title_size * 0.18), ty - int(title_size * 0.1)), 'zafu', font=mincho(title_size), fill=FG_HIGH)
        if tag:
            d.text((x, ty + int(title_size * 1.35)), 'private zcash wallet', font=mono(tag_size), fill=MUTED)
            d.text((x, ty + int(title_size * 1.35) + int(tag_size * 1.6)), 'zcash · penumbra · zigner', font=mono(int(tag_size * 0.8)), fill=GOLD)
        img.save(os.path.join(OUT, fname), 'PNG')

    tile((440, 280), 'small-promo-440x280.png', 52, 15)
    tile((1400, 560), 'marquee-1400x560.png', 120, 34)

    # store icon: 96px artwork inside 128 with transparent padding (cws icon guideline)
    ic = Image.open(seal_path()).convert('RGBA').resize((96, 96), Image.LANCZOS)
    icon = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    icon.paste(ic, (16, 16), ic)
    icon.save(os.path.join(OUT, 'store-icon-128.png'), 'PNG')


for CHANNEL in ('beta', 'prod'):
    OUT = os.path.join(HERE, '../images', CHANNEL)
    os.makedirs(OUT, exist_ok=True)
    build()
    print('wrote', os.path.normpath(OUT))
