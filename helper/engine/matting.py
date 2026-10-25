"""Isolated, file-based local matting worker. No Photoshop or network credentials."""
import argparse, json, os
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('action', choices=['probe','download','matte'])
parser.add_argument('--model',default='u2netp',choices=['u2netp','u2net_human_seg','isnet-general-use'])
parser.add_argument('--input');parser.add_argument('--output');parser.add_argument('--mask')
parser.add_argument('--erode',type=int,default=0);parser.add_argument('--feather',type=float,default=0)
args=parser.parse_args()
import onnxruntime as ort
if args.action=='probe':
    import rembg
    print(json.dumps({'ok':True,'providers':ort.get_available_providers()}));raise SystemExit
from rembg import new_session, remove
session=new_session(args.model,providers=['CPUExecutionProvider'])
if args.action=='download':
    print(json.dumps({'ok':True,'model':args.model,'providers':session.inner_session.get_providers()}));raise SystemExit
from PIL import Image, ImageOps, ImageFilter, ImageChops
source=ImageOps.exif_transpose(Image.open(args.input)).convert('RGBA')
mask=remove(source,session=session,only_mask=True).convert('L')
if args.erode>0:mask=mask.filter(ImageFilter.MinFilter(args.erode*2+1))
if args.erode<0:mask=mask.filter(ImageFilter.MaxFilter(abs(args.erode)*2+1))
if args.feather>0:mask=mask.filter(ImageFilter.GaussianBlur(args.feather))
mask=ImageChops.multiply(mask,source.getchannel('A'))
mask.save(args.mask)
source.putalpha(mask);source.save(args.output)
print(json.dumps({'ok':True,'width':source.width,'height':source.height,'model':args.model,'mask':args.mask}))
