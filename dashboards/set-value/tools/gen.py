import json, os, sys, time, concurrent.futures as cf, urllib.request
BASE="https://api.tcgdex.net/v2/en"
setmap=json.load(open('setmap.json')); jt={s['id']:s for s in json.load(open('jt_sets.json'))['sets']}
def get(path):
    p='cache/'+path.replace('/','_')+'.json'
    if os.path.exists(p): return json.load(open(p))
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE+path, headers={'User-Agent':'TomeCollective/1.0'}), timeout=30) as r: d=json.load(r)
            json.dump(d,open(p,'w')); return d
        except Exception as e:
            time.sleep(1.5*(i+1))
    return None
VAR=[('normal','Normal'),('reverse','Reverse Holo'),('holo','Holo'),('firstEdition','1st Edition')]
done=0
for jtid, dexid in sorted(setmap.items(), key=lambda kv: jt[kv[0]]['release_date'] or '', reverse=True):
    outp=f'out/pokemon/{jtid}.json'
    if os.path.exists(outp): continue
    s=get(f'/sets/{dexid}')
    if not s: print('SET FAIL',jtid); continue
    ids=[c['id'] for c in s.get('cards',[])]
    with cf.ThreadPoolExecutor(8) as ex: cards=list(ex.map(lambda i: get(f'/cards/{i}'), ids))
    rows=[]
    for c in cards:
        if not c: continue
        v=c.get('variants') or {}
        vs=[label for k,label in VAR if v.get(k)]
        rows.append({'n':c.get('localId'),'name':c.get('name'),'r':c.get('rarity'),'v':vs or ['Normal']})
    rows.sort(key=lambda r:(len(str(r['n'])) if str(r['n']).isdigit() else 99, str(r['n'])))
    json.dump({'game':'pokemon','set':jtid,'source':'tcgdex','source_set':dexid,'name':s.get('name'),'official':(s.get('cardCount') or {}).get('official'),'total':len(rows),'cards':rows}, open(outp,'w'), separators=(',',':'))
    done+=1; print(jtid, len(rows), flush=True)
print('DONE', done)
