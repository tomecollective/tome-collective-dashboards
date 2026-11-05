import json,re,urllib.request,urllib.parse,time,collections
def get(u):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'TomeCollective/1.0'}),timeout=30) as r: return json.load(r)
        except Exception as e: time.sleep(2)
    return None
norm=lambda s: re.sub(r'[^a-z0-9]+',' ',s.lower().replace('&','and').replace('’',"'")).strip()
# ---------- Lorcana ----------
jt=json.load(open('jt_disney-lorcana.json'))['sets']; lc=get('https://api.lorcast.com/v0/sets')['results']
lmap={norm(s['name']):s for s in lc}
out={}
for s in jt:
    m=lmap.get(norm(s['name']))
    if not m: print('LORCANA unmatched', s['name']); continue
    code=m['code']; rows=[]
    reg=get(f'https://api.lorcast.com/v0/cards/search?q={urllib.parse.quote("set:"+code)}') or {}
    ench=get(f'https://api.lorcast.com/v0/cards/search?q={urllib.parse.quote("set:"+code+" rarity:enchanted")}') or {}
    icon=get(f'https://api.lorcast.com/v0/cards/search?q={urllib.parse.quote("set:"+code+" rarity:iconic")}') or {}
    base='https://cards.lorcast.io/card/digital/small'
    def row(c,v):
        img=((c.get('image_uris') or {}).get('digital') or {}).get('small') or ''
        i=img[len(base)+1:] if img.startswith(base+'/') else (img or None)
        r={'n':c['collector_number'],'name':c['name']+(' - '+c['version'] if c.get('version') else ''),'r':(c.get('rarity') or '').replace('_',' '),'v':v}
        if i: r['i']=i
        return r
    for c in reg.get('results',[]): rows.append(row(c,['Normal','Foil']))
    for c in ench.get('results',[])+icon.get('results',[]): rows.append(row(c,['Foil']))
    rows.sort(key=lambda r:(len(r['n']) if r['n'].isdigit() else 99, r['n']))
    official=len(reg.get('results',[]))
    out[s['id']]={'name':s['name'],'source':'lorcast','source_set':code,'official':official,'total':len(rows),'img_base':base,'img_suffix':'','cards':rows}
    print('LORCANA',s['name'],official,len(rows))
json.dump(out,open('/mnt/user-data/outputs/set-value/cards/disney-lorcana.json','w'),separators=(',',':'))
# ---------- One Piece ----------
jt=json.load(open('jt_one-piece-card-game.json'))['sets']; op=get('https://optcgapi.com/api/allSets/')
def n2(s): return norm(re.sub(r'\s*-\s*',' ',s).replace('vol. 2','vol 2'))
omap={n2(s['set_name']):s for s in op}
RAR={'C':'Common','UC':'Uncommon','R':'Rare','SR':'Super Rare','L':'Leader','SEC':'Secret Rare','P':'Promo','SP':'Special','TR':'Treasure Rare'}
out={}
for s in jt:
    m=omap.get(n2(s['name']))
    if not m: continue
    d=get(f"https://optcgapi.com/api/sets/{m['set_id']}/") or []
    by=collections.OrderedDict()
    for r in d: by.setdefault(r['card_set_id'],[]).append(r)
    rows=[]
    for cid,lst in by.items():
        mains=[r for r in lst if not re.search(r'_p\d+$',r['card_image_id'])] or lst
        main=mains[0]; alts=[r for r in lst if re.search(r'_p\d+$',r['card_image_id'])]
        v=['Normal']+[f'Alt Art {i+1}' for i in range(len(alts))]
        name=re.sub(r'\s*\((\d{3})\)$','',main['card_name'])
        rows.append({'n':cid,'name':name,'r':RAR.get(main['rarity'],main['rarity']),'v':v,'i':main['card_image_id']})
    out[s['id']]={'name':s['name'],'source':'optcgapi','source_set':m['set_id'],'official':len(rows),'total':len(rows),'img_base':'https://optcgapi.com/media/static/Card_Images','img_suffix':'.jpg','cards':rows}
    print('ONEPIECE',s['name'],m['set_id'],len(rows))
json.dump(out,open('/mnt/user-data/outputs/set-value/cards/one-piece-card-game.json','w'),separators=(',',':'))
print('unmatched one piece boosters:', [s['name'] for s in jt if n2(s['name']) not in omap and not re.search(r'starter|deck|pre-release|release event|tournament|promotion|demo|revision|collection sets',s['name'],re.I)])
