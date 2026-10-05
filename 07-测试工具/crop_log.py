"""从端到端截图里裁出固定的诊断日志区（页面左下角 fixed 的黑底绿字框）。"""
import sys
import pathlib
from PIL import Image

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name(src.stem + "_log.png")

im = Image.open(src).convert("RGB")
W, H = im.size
print("full size:", W, "x", H)

px = im.load()


def is_green(p):
    r, g, b = p
    return g > 120 and r < 110 and b < 110


def is_dark(p):
    r, g, b = p
    return r < 70 and g < 70 and b < 70


# 从底部往上找日志框的上边界：日志框是「黑底 + 绿字」的长条
bottom = H - 1
top = None
row_has_green = []
for y in range(H - 1, max(0, H - 900), -1):
    cnt_g = 0
    for x in range(0, W, 3):
        if is_green(px[x, y]):
            cnt_g += 1
    row_has_green.append((y, cnt_g))
    if cnt_g > 3 and top is None:
        top = y
# 找最上方还有绿字的行
ys = [y for y, c in row_has_green if c > 1]
if ys:
    top = min(ys)
print("green rows found:", len(ys), "top:", top, "bottom:", bottom)

# 上边界留白；黑底框通常从绿字上方 ~10px 开始，再往上多留 200px 保证覆盖整个框
crop_top = max(0, (top if top else H - 600) - 320)
crop = im.crop((0, crop_top, W, H))
crop.save(dst)
print("saved:", dst, crop.size)
