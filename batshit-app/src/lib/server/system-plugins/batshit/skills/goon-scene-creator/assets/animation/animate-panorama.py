"""Render a fixed panorama with artwork-specific light masks and periodic motion.
Requires Python, numpy, Pillow, OpenCV and FFmpeg. No model inference is performed.
See references/animated-panorama.md in the Goon Scene Creator skill.
"""
import argparse,json,subprocess,time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
parser=argparse.ArgumentParser()
parser.add_argument('still',type=Path)
parser.add_argument('plan',type=Path)
parser.add_argument('output',type=Path)
parser.add_argument('--encoder',choices=('libx264','h264_nvenc','av1_nvenc'),default='libx264')
parser.add_argument('--width',type=int,default=4096)
parser.add_argument('--prepare-only',action='store_true')
args=parser.parse_args()
plan=json.loads(args.plan.read_text(encoding='utf-8'))
duration=float(plan.get('duration_seconds',12)); fps=int(plan.get('fps',24))
if not (1<=duration<=120 and 1<=fps<=60 and duration*fps==int(duration*fps)):
    raise ValueError('Use a whole number of frames, 1-120 seconds, 1-60 fps')
if args.width<256 or args.width>8192 or args.width%4:
    raise ValueError('Width must be 256-8192 and divisible by four')
if args.output.exists() and not args.prepare_only: raise FileExistsError(args.output)
im=Image.open(args.still).convert('RGB')
if im.width!=im.height*2: raise ValueError('Input must be a full 2:1 panorama')
source=np.asarray(im.resize((args.width,args.width//2),Image.Resampling.LANCZOS))
h,w=source.shape[:2]
reference=plan['reference_size']
if len(reference)!=2 or reference[0]!=reference[1]*2 or reference[0]<=0:
    raise ValueError('Plan reference_size must be a positive 2:1 size')
coordinate_scale=w/reference[0]
small=cv2.resize(source,(2048,1024),interpolation=cv2.INTER_AREA)
rng=np.random.default_rng(360911);patches=[];mask_audit=[];atlas=small.copy()
def add_light(rect, kind, index):
    x1, y1, x2, y2 = [round(n * coordinate_scale) for n in rect]
    base = source[y1:y2, x1:x2].astype(np.float32)
    red,green,blue = np.moveaxis(base,2,0)
    maximum = base.max(axis=2)
    minimum = base.min(axis=2)
    # Color discrimination matters: blue haze is saturated too. Cyan emitters
    # have much more green relative to blue than the surrounding night sky.
    pink = np.clip((red-green-15)/35,0,1)*np.clip((blue-green-8)/25,0,1)
    cyan = np.clip((np.minimum(green,blue)-red-25)/40,0,1)*np.clip((green-.72*blue-4)/25,0,1)
    amber = np.clip((red-blue-25)/40,0,1)*np.clip((green-blue+5)/25,0,1)
    white = np.clip((minimum-150)/55,0,1)*np.clip((50-(maximum-minimum))/40,0,1)
    color_key = np.maximum.reduce([pink,cyan,amber,white])
    # Estimate the non-emissive background from padded spatial context. Opening
    # removes narrow bright lights without treating the ROI edge as an object.
    pad=max(8,round(64*w/8192))
    px1,py1,px2,py2=max(0,x1-pad),max(0,y1-pad),min(w,x2+pad),min(h,y2+pad)
    context=source[py1:py2,px1:px2]
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(max(3,round(60*w/8192)//2*2+1),)*2)
    opened=cv2.morphologyEx(context,cv2.MORPH_OPEN,kernel).astype(np.float32)
    background=opened[y1-py1:y2-py1,x1-px1:x2-px1]
    emission=np.maximum(base-background,0)
    contrast=np.clip((emission.max(axis=2)-12)/38,0,1)
    contrast=contrast*contrast*(3-2*contrast)
    mask=color_key*contrast
    # No blur/dilation after keying: that would leak subtraction into the sky.
    yy, xx = np.mgrid[:y2-y1, :x2-x1]
    edge = np.minimum.reduce([xx, yy, x2-x1-1-xx, y2-y1-1-yy])
    mask *= np.clip(edge / max(1,10*w/8192), 0, 1)
    patches.append(dict(kind=kind, box=[x1,y1,x2,y2], base=base,
                        mask=mask[...,None],emission=emission,
                        cycles=1 + index % (3 if kind=='neon' else 1),
                        phase=float(rng.uniform(0, 2*np.pi))))
    mask_audit.append(dict(kind=kind,box=[x1,y1,x2,y2],
                           affected_fraction=float((mask>0).mean()),
                           peak_mask=float(mask.max()),
                           peak_dim_change=float((emission*mask[...,None]).max())*(.65 if kind=='neon' else .82)))
    cv2.rectangle(atlas, (round(x1*2048/w),round(y1*2048/w)), (round(x2*2048/w),round(y2*2048/w)), (0,255,180), 1)


for i,target in enumerate(plan['targets']):
    kind=target['kind']; rect=target['box']
    if kind not in ('neon','window','star','color') or len(rect)!=4 or not all(np.isfinite(n) for n in rect):
        raise ValueError(f'Invalid target {i}')
    x1,y1,x2,y2=[round(n*coordinate_scale) for n in rect]
    if not (0<=x1<x2<=w and 0<=y1<y2<=h): raise ValueError(f'Target {i} outside the panorama')
    if kind in ('neon','window'):
        add_light(rect,kind,i)
    elif kind=='star':
        base=source[y1:y2,x1:x2].astype(np.float32)
        yy,xx=np.mgrid[:y2-y1,:x2-x1];xx=xx-(x2-x1-1)/2;yy=yy-(y2-y1-1)/2
        stretch=1/max(.45,np.sin(np.pi*(y1+y2-1)/2/h));scale=w/8192
        d2=(xx/stretch)**2+yy**2
        halo=np.exp(-d2/(35*scale*scale))[...,None]
        core=np.maximum(base-cv2.GaussianBlur(base,(0,0),max(.5,4*scale)),0)
        emission=core*1.25+halo*np.array([38,48,68],dtype=np.float32)
        patches.append(dict(kind=kind,box=[x1,y1,x2,y2],base=base,emission=emission))
    else:
        base=source[y1:y2,x1:x2].astype(np.float32)
        maximum=base.max(axis=2);minimum=base.min(axis=2);chroma=maximum-minimum
        mask=np.clip((maximum-35)/85,0,1)*np.clip((chroma-18)/65,0,1)
        mask*=np.clip((base[:,:,0]-base[:,:,1]-5)/35,0,1)
        yy,xx=np.mgrid[:y2-y1,:x2-x1];edge=np.minimum.reduce([xx,yy,x2-x1-1-xx,y2-y1-1-yy])
        mask*=np.clip(edge/max(1,32*w/8192),0,1)
        mask=cv2.GaussianBlur(mask,(0,0),max(.5,2*w/8192))
        patches.append(dict(kind=kind,box=[x1,y1,x2,y2],base=base,mask=mask[...,None],chroma=chroma[...,None],minimum=minimum[...,None]))
    cycles=target.get('cycles',1);phase=float(target.get('phase',rng.uniform(0,2*np.pi)))
    if not isinstance(cycles,int) or not 1<=cycles<=12 or not np.isfinite(phase):
        raise ValueError(f'Target {i} needs integer cycles (1-12) and finite phase')
    patches[-1].update(cycles=cycles,phase=phase)
totals = {kind:sum(p['kind']==kind for p in patches) for kind in ('star','neon','window','color')}
prefix = args.output.with_suffix('')
Image.fromarray(atlas).save(str(prefix)+'-targets.jpg')
metadata = [{k:v for k,v in p.items() if k not in ('base','mask','emission','chroma','minimum')} for p in patches]
Path(str(prefix)+'-targets.json').write_text(json.dumps(metadata,indent=2),encoding='utf-8')
Path(str(prefix)+'-mask-audit.json').write_text(json.dumps(mask_audit,indent=2),encoding='utf-8')
print(json.dumps({'targets':len(patches),**totals}),flush=True)

def render(t):
    frame = source.copy()
    for p in patches:
        angle=2*np.pi*p['cycles']*t/duration + p['phase']
        wave=(1+np.sin(angle))*.5
        if p['kind']=='star':
            delta=p['emission']*(wave**3*2.8)
        elif p['kind']=='neon':
            delta=p['emission']*p['mask']*(.9*wave-.65)
        elif p['kind']=='color':
            palette=np.array([[1,.12,.55],[.58,.12,1],[.12,.40,1]],dtype=np.float32)
            position=(angle/(2*np.pi)*3)%3
            first=int(position)
            blend=position-first
            blend=blend*blend*(3-2*blend)
            hue=palette[first]*(1-blend)+palette[(first+1)%3]*blend
            colored=p['minimum']+p['chroma']*hue
            delta=(colored-p['base'])*p['mask']*.95
        else:
            # Independent occupied windows softly dim and relight.
            on=1/(1+np.exp(-10*(wave-.5)))
            delta=p['emission']*p['mask']*(-.82*(1-on))
        x1,y1,x2,y2=p['box']
        # Sum any overlapping light regions instead of erasing another patch.
        frame[y1:y2,x1:x2]=np.clip(frame[y1:y2,x1:x2].astype(np.float32)+delta,0,255).astype(np.uint8)
    return frame

for t in (0,duration/4,duration/2,duration*3/4):
    Image.fromarray(cv2.resize(render(t),(2048,1024))).save(str(prefix)+f'-preview-{t}.jpg')
# Inspect the pathological case directly: every breathing light at minimum.
# This cannot rely on phases coincidentally exposing a leak during playback.
darkest=source.copy()
for p in patches:
    if p['kind'] not in ('neon','window'):
        continue
    x1,y1,x2,y2=p['box']
    amount=.65 if p['kind']=='neon' else .82
    darkest[y1:y2,x1:x2]=np.clip(darkest[y1:y2,x1:x2].astype(np.float32)-amount*p['emission']*p['mask'],0,255).astype(np.uint8)
Image.fromarray(darkest).save(str(prefix)+'-all-lights-minimum.png')
if args.prepare_only:
    raise SystemExit(0)
if args.output.exists():
    raise FileExistsError(args.output)
frames=int(duration*fps)
encoder_args=['-c:v',args.encoder,'-g',str(fps*2)]
if args.encoder=='libx264': encoder_args+=['-preset','medium','-crf','18']
else: encoder_args+=['-preset','p6','-tune','hq','-rc','vbr','-cq','18','-b:v','0']
if args.encoder=='av1_nvenc': encoder_args+=['-level','6.0','-tier','1']
cmd=['ffmpeg','-hide_banner','-nostdin','-loglevel','warning','-f','rawvideo','-pix_fmt','rgb24','-s',f'{w}x{h}','-r',str(fps),'-i','pipe:0','-an','-vf','scale=out_color_matrix=bt709:out_range=tv,format=yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','iec61966-2-1','-color_range','tv',*encoder_args,'-pix_fmt','yuv420p','-movflags','+faststart','-map_metadata','-1',str(args.output)]
start=time.monotonic()
with args.output.with_suffix('.encode.log').open('wb') as errors:
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=errors)
    try:
        for i in range(frames):
            proc.stdin.write(render(i/fps).tobytes())
            if i%24==0:
                print(json.dumps({'frame':i,'total':frames,'seconds':round(time.monotonic()-start,1)}),flush=True)
        proc.stdin.close()
        if proc.wait():
            raise RuntimeError('Encoding failed; see encode log')
    except BaseException:
        proc.kill();proc.wait();raise
report=dict(kind='authored periodic stars, neon, windows and color transitions',source=str(args.still),
            light_mask='emitter hue plus local contrast; modulate only positive emission residual',
            output=str(args.output),width=w,height=h,fps=fps,frames=frames,duration_seconds=duration,
            stars=totals['star'],neon=totals['neon'],windows=totals['window'],color_facades=totals['color'],
            loop='integer-frequency periodic envelopes; no duplicate endpoint',
            pixel_exact_period=bool(np.array_equal(render(0),render(duration))),
            bytes=args.output.stat().st_size,elapsed_seconds=time.monotonic()-start)
args.output.with_suffix('.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2),flush=True)
