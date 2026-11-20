"""Convert a MobileSheets backup (.msb) into a Setlist Stand backup (.zip).
Usage: python3 msb_convert.py MobileSheets_YYYY-MM-DD.msb out.zip
Format notes (MobileSheets backup v33, worked out 2026-11-19):
- After an 8-byte header: named settings blocks [u16 name len][name][u64 len][data],
  then a user_filters/json section, then the SQLite database (find 'SQLite format 3',
  its length is the u64 just before it).
- After the database: one entry per row of the Files table:
  [8-byte marker][u64 SongId][u64 length][file bytes]; an entry with no file is just marker+SongId.
- AnnotationsBase.Type: 0 text box, 1 freehand, 3 stamp, 6 line. Coordinates are in
  source-page points (SourcePageWidth x SourcePageHeight), origin top-left.
- AnnotationPoints.Points = little-endian doubles. Type 1: [mode, then groups of
  (n, width, n values)]; a (FLT_MAX, FLT_MAX) pair splits sub-strokes. Others: x,y pairs.
- Colors are signed ARGB ints.
"""
import sys,sqlite3,json,zipfile,io,struct,tempfile,os,logging
import pypdf,re
ARTIST_FROM_FILE={'High And Dry - Chords':'Radiohead','What Goes On - Pro':'The Beatles'}
SMALL={'a','an','and','the','of','in','on','at','to','for','or','by','as'}
def tcase(s):
    if s!=s.lower() and s!=s.capitalize() and not s.islower(): pass
    words=s.split(); out=[]
    for i,w in enumerate(words):
        lw=w.lower()
        if i and i<len(words)-1 and lw in SMALL: out.append(lw)
        elif w.isupper() and len(w)>1 and w not in ('OLD',): out.append(w)
        else: out.append(w[:1].upper()+w[1:])
    return ' '.join(out)
def split_name(raw):
    t=raw.strip()
    t=re.sub(r'\.pdf$','',t,flags=re.I)
    artist=ARTIST_FROM_FILE.get(t,'')
    t=re.sub(r'\s*\(1\)$','',t)
    t=re.sub(r'\s+chords$','',t,flags=re.I)
    t=t.replace('Dont ',"Don't ")
    t=re.sub(r'\s*-\s*(Chords|Pro|Lyrics - Chords)(\s*\d+)?$',lambda m:(' '+m.group(2).strip()) if m.group(2) else '',t)
    parts=[p.strip() for p in t.split(' - ')]
    if len(parts)==2 and not artist and len(parts[1])>2:
        artist,t=parts
    elif len(parts)==2:
        t=parts[0]+' - '+parts[1]
    version=''
    m=re.match(r'^(.*?)\s+(OLD|updated|Lyrics|\d+)$',t)
    if m: t,version=m.group(1),m.group(2).lower()
    m=re.match(r'^(.*?)\s+(in [A-G](?:\s+and\s+[A-G])?)$',t)
    if m: t,version=m.group(1),m.group(2)
    m=re.match(r'^(.*?)\s+-\s+([A-G])$',t)
    if m: t,version=m.group(1),'in '+m.group(2)
    t=tcase(t)
    if artist=='Cat Stevens Yusuf Islam': artist='Cat Stevens'
    return t,artist,version
def display(t,a,v): return t+(f' ({v})' if v else '')
def filename(t,a,v):
    n=display(t,a,v)+(f' - {a}' if a else '')
    return re.sub(r'[\\/:*?"<>|]','',n).strip()+'.pdf'

logging.disable(logging.CRITICAL)
BIG=1e38
def parse_points(pts,typ):
    v=struct.unpack('<%dd'%(len(pts)//8),pts)
    if typ!=1: return [(None,[(v[i],v[i+1]) for i in range(0,len(v)-1,2)])]
    out=[];i=1
    while i+1<len(v):
        n=int(v[i]);w=v[i+1];vals=v[i+2:i+2+n];i+=2+n;cur=[]
        for j in range(0,len(vals)-1,2):
            x,y=vals[j],vals[j+1]
            if x>BIG or y>BIG:
                if cur: out.append((w,cur));cur=[]
            else: cur.append((x,y))
        if cur: out.append((w,cur))
    return out
def hexcol(v):
    v=(v if v is not None else -16777216)&0xffffffff
    return '#%02x%02x%02x'%((v>>16)&255,(v>>8)&255,v&255)
def main(msb,out):
    d=open(msb,'rb').read()
    s=d.find(b'SQLite format 3\x00'); ln=struct.unpack('>Q',d[s-8:s])[0]
    tmp=tempfile.NamedTemporaryFile(suffix='.db',delete=False); tmp.write(d[s:s+ln]); tmp.close()
    c=sqlite3.connect(tmp.name)
    p=s+ln; marker=d[p:p+8]; blobs={}
    while d[p:p+8]==marker:
        sid=struct.unpack('>Q',d[p+8:p+16])[0]
        if d[p+16:p+24]==marker or p+24>len(d): p+=16; continue
        n=struct.unpack('>Q',d[p+16:p+24])[0]; blobs.setdefault(sid,[]).append(d[p+24:p+24+n]); p+=24+n
    songs=[];ink={};rep={'skipped':[],'trimmed':[],'textboxes':0,'stamps':0}
    z=zipfile.ZipFile(out,'w',zipfile.ZIP_STORED)
    for sid,title,created in c.execute('select Id,Title,CreationDate from Songs').fetchall():
        f=c.execute('select PageOrder,SourceFilePageCount from Files where SongId=? and Type=1',(sid,)).fetchone()
        data=next((b for b in blobs.get(sid,[]) if b[:5]==b'%PDF-'),None)
        if not f or data is None: rep['skipped'].append(title); continue
        order,pages=f
        if order and order!='1-%d'%pages and '-' in order and ',' not in order:
            a,b=map(int,order.split('-')); r=pypdf.PdfReader(io.BytesIO(data)); w=pypdf.PdfWriter()
            for i in range(a-1,b): w.add_page(r.pages[i])
            bio=io.BytesIO(); w.write(bio); data=bio.getvalue(); pages=b-a+1; rep['trimmed'].append(title)
        id='ms%d'%sid; z.writestr('files/%s.pdf'%id,data)
        t,a,v=split_name(title)
        songs.append({'id':id,'title':filename(t,a,v)[:-4],'song':t,'artist':a,'version':v,'file':filename(t,a,v),'pages':pages,'added':created or 0})
    known={x['id'] for x in songs}
    for sid,typ,page,sw,sh,op,pts,col,lw in c.execute('''select b.SongId,b.Type,b.Page,b.SourcePageWidth,b.SourcePageHeight,b.Opacity,p.Points,d.LineColor,d.LineWidth
      from AnnotationsBase b left join AnnotationPoints p on p.AnnotationId=b.Id left join DrawAnnotations d on d.BaseId=b.Id order by b.Id''').fetchall():
        if 'ms%d'%sid not in known: continue
        if typ==0: rep['textboxes']+=1; continue
        if typ==3: rep['stamps']+=1; continue
        if not pts: continue
        for w,xy in parse_points(pts,typ):
            ink.setdefault('ms%d:%d'%(sid,page+1),[]).append({'t':'hl' if (op or 100)<100 else 'pen','c':hexcol(col),
              'w':round((w or lw or 1)/sw,5),'p':[[round(x/sw,4),round(y/sh,4)] for x,y in xy]})
    sets=[{'id':'msset%d'%i,'name':n,'created':cr or 0,
           'songs':[x for x in ('ms%d'%r[0] for r in c.execute('select SongId from SetlistSong where SetlistId=? order by Id',(i,))) if x in known]}
          for i,n,cr in c.execute('select Id,Name,DateCreated from Setlists order by Id').fetchall()]
    z.writestr('library.json',json.dumps({'app':'setlist-stand','version':1,'saved':'from MobileSheets','songs':songs,'sets':sets,'ink':ink}))
    z.close(); os.unlink(tmp.name)
    rep.update(songs=len(songs),setlists=len(sets),annotated_pages=len(ink)); print(json.dumps(rep,indent=1))
if __name__=='__main__': main(*sys.argv[1:3])
