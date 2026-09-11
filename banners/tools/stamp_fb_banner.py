#!/usr/bin/env python3
"""Re-stamp the date/run/day line and the objective line on the Fast Break Classic banner.
usage: stamp_fb_banner.py TEMPLATE.png OUT.png "AUGUST 20, 2026 | RUN 10 · DAY 2" "25 REB & 3 BLK"
Calibrated to tc-wnba-fastbreak-classic-banner (1824x608): Inter Medium 17px, tracking 4.2,
colour (188,188,189), line 1 cap top y=379 from x=511, line 2 cap top y=419.
"""
import sys
from PIL import Image, ImageDraw, ImageFont
FONT='Inter-Medium.ttf'; SIZE=17; TRACK=4.3; COLOR=(188,188,189,255); BG=(9,9,14,255)
X=511; CAP1=379; CAP2=419
ERASE=[(505,372,1160,398),(505,412,1160,438)]   # stop short of the dashed rules at y~405/445 and the box at x~1290
def draw_tracked(d,f,x,cap_top,text):
    # align cap top: measure 'H' offset
    hb=f.getbbox('H'); y=cap_top-hb[1]
    for ch in text:
        d.text((x,y),ch,font=f,fill=COLOR); d.text((x+0.8,y),ch,font=f,fill=COLOR)  # faux semibold
        x+=f.getlength(ch)+TRACK
def main(tpl,out,line1,line2):
    im=Image.open(tpl).convert('RGBA'); d=ImageDraw.Draw(im)
    for box in ERASE: d.rectangle(box,fill=BG)
    f=ImageFont.truetype(FONT,SIZE)
    draw_tracked(d,f,X,CAP1,line1.upper()); draw_tracked(d,f,X,CAP2,line2.upper())
    im.save(out)
if __name__=='__main__': main(*sys.argv[1:5])
