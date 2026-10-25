"""Isolated local matting worker; only download action may fetch model weights."""
import argparse
import json
import os
from pathlib import Path


def refine_mask(mask, original_alpha, threshold=0, denoise=0, erode=0, feather=0):
    """Keep soft confidence by default; never increase the source's existing alpha."""
    from PIL import ImageFilter, ImageChops
    mask = mask.convert('L')
    if denoise:
        mask = mask.filter(ImageFilter.MedianFilter(denoise * 2 + 1))
    if threshold > 0:
        mask = mask.point(lambda p: 255 if p / 255 >= threshold else 0)
    if erode > 0:
        mask = mask.filter(ImageFilter.MinFilter(erode * 2 + 1))
    if erode < 0:
        mask = mask.filter(ImageFilter.MaxFilter(abs(erode) * 2 + 1))
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return ImageChops.multiply(mask, original_alpha.convert('L'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['probe', 'download', 'matte'])
    parser.add_argument('--model', default='u2netp', choices=['u2netp', 'u2net_human_seg', 'isnet-general-use'])
    parser.add_argument('--input'); parser.add_argument('--output'); parser.add_argument('--mask')
    parser.add_argument('--erode', type=int, default=0)
    parser.add_argument('--feather', type=float, default=0)
    parser.add_argument('--threshold', type=float, default=0)
    parser.add_argument('--denoise', type=int, default=0)
    parser.add_argument('--inference', action='store_true')
    args = parser.parse_args()
    if not -15 <= args.erode <= 15 or not 0 <= args.feather <= 30 or not 0 <= args.threshold <= 1 or not 0 <= args.denoise <= 5:
        parser.error('修边参数无效')
    import onnxruntime as ort
    from rembg import new_session, remove
    if args.action == 'probe' and not args.inference:
        print(json.dumps({'ok': True, 'providers': ort.get_available_providers(), 'selectedBackend': 'CPUExecutionProvider', 'inference': False}))
        return
    if args.action != 'download':
        home = Path(os.environ.get('U2NET_HOME', str(Path.home() / '.u2net')))
        candidates = [home / f'{args.model}.onnx', home / 'models' / args.model / f'{args.model}.onnx']
        if not any(p.is_file() for p in candidates):
            raise RuntimeError(f'模型缺失：{args.model}；请先下载，推理不会隐式下载模型')
    session = new_session(args.model, providers=['CPUExecutionProvider'])
    if args.action == 'download':
        print(json.dumps({'ok': True, 'model': args.model, 'providers': session.inner_session.get_providers()}))
        return
    from PIL import Image, ImageOps
    if args.action == 'probe':
        import numpy as np
        # A real ONNX execution, not merely import/session construction.
        sample = Image.fromarray(np.random.default_rng(0).integers(0, 256, (64, 64, 3), dtype=np.uint8))
        result = remove(sample, session=session, only_mask=True)
        if result.size != sample.size:
            raise RuntimeError('推理探测输出尺寸无效')
        print(json.dumps({'ok': True, 'model': args.model, 'providers': session.inner_session.get_providers(), 'inference': True, 'width': result.width, 'height': result.height}))
        return
    if not all([args.input, args.output, args.mask]):
        parser.error('matte 需要 input/output/mask')
    source = ImageOps.exif_transpose(Image.open(args.input)).convert('RGBA')
    mask = remove(source, session=session, only_mask=True).convert('L')
    mask = refine_mask(mask, source.getchannel('A'), args.threshold, args.denoise, args.erode, args.feather)
    mask.save(args.mask)
    source.putalpha(mask); source.save(args.output)
    print(json.dumps({'ok': True, 'width': source.width, 'height': source.height, 'model': args.model, 'mask': args.mask}))


if __name__ == '__main__':
    main()
