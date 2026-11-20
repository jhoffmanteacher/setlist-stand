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
- Crop(SongId, Page 0-based, Left, Top, Right, Bottom, Rotation): the kept rectangle in source-page points;
  all zeros, or the full page (Right/Bottom ~ page size), means no crop.
- Text boxes (Type 0): TextboxAnnotations(Text, FontSize in source-page points, TextColor); AnnotationPoints holds three
  x,y points: top-left corner, bottom-right corner, text baseline start. FontStyle 1 = bold (not carried over).
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
    t=t.replace('Dont ',"Don't ")
    # drop a trailing "- Chords" / "- Pro" first ("- Lyrics - Chords" keeps "Lyrics" as the version), then a bare "chords"
    t=re.sub(r'\s*-\s*(Chords|Pro|Lyrics - Chords)(\s*\d+)?$',lambda m:(' '+m.group(2).strip() if m.group(2) else '')+(' Lyrics' if m.group(1).startswith('Lyrics') else ''),t)
    t=re.sub(r'\s+chords$','',t,flags=re.I)
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
def page_sizes(data):
    """Displayed size of every page in points (CropBox, with /Rotate applied): what pdf.js draws and crops are measured on."""
    r=pypdf.PdfReader(io.BytesIO(data)); out=[]
    for pg in r.pages:
        b=pg.cropbox; w=float(b.width); h=float(b.height)
        if int(pg.get('/Rotate',0) or 0)%180: w,h=h,w
        out.append((w,h))
    return out
def convert_crops(rows,sizes,known,rep):
    """rows: (SongId, Page, L, T, R, B). Returns {songId: {'all': rect|None, 'pages': {pageNumber(1-based str): rect}}}."""
    per={}
    for sid,pg,l,t,r,b in rows:
        k='ms%d'%sid
        if k not in known or not any((l,t,r,b)): continue
        dims=sizes.get(k)
        if not dims or pg>=len(dims): continue
        w,h=dims[pg]
        x,y=max(0,l/w),max(0,t/h); wd,ht=min(1,r/w)-x,min(1,b/h)-y
        if x<.005 and y<.005 and x+wd>.995 and y+ht>.995: continue      # the whole page: no crop
        if wd<=.02 or ht<=.02: continue
        per.setdefault(k,{})[pg+1]={'x':round(x,4),'y':round(y,4),'w':round(wd,4),'h':round(ht,4)}
    out={}
    for k,pages in per.items():
        n=len(sizes[k]); first=pages.get(1)
        same=len(pages)==n and all(all(abs(p[a]-first[a])<.003 for a in 'xywh') for p in pages.values())
        if same: out[k]={'all':first,'pages':{}}; rep['crops_song_wide']+=1
        else: out[k]={'all':None,'pages':{str(p):v for p,v in sorted(pages.items())}}; rep['crops_per_page_songs']+=1; rep['crops_per_page']+=len(pages)
    return out
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
    songs=[];ink={};nofile={};sizes={};rep={'skipped':[],'trimmed':[],'textboxes':0,'textboxes_converted':0,'textboxes_blank':0,'stamps':0,'breaks':{},'crop_rows_total':0,'crop_rows_with_a_crop':0,'crops_song_wide':0,'crops_per_page_songs':0,'crops_per_page':0}
    z=zipfile.ZipFile(out,'w',zipfile.ZIP_STORED)
    for sid,title,created in c.execute('select Id,Title,CreationDate from Songs').fetchall():
        f=c.execute('select PageOrder,SourceFilePageCount from Files where SongId=? and Type=1',(sid,)).fetchone()
        data=next((b for b in blobs.get(sid,[]) if b[:5]==b'%PDF-'),None)
        if not f or data is None: rep['skipped'].append(title); nofile[sid]=title; continue
        order,pages=f
        if order and order!='1-%d'%pages and '-' in order and ',' not in order:
            a,b=map(int,order.split('-')); r=pypdf.PdfReader(io.BytesIO(data)); w=pypdf.PdfWriter()
            for i in range(a-1,b): w.add_page(r.pages[i])
            bio=io.BytesIO(); w.write(bio); data=bio.getvalue(); pages=b-a+1; rep['trimmed'].append(title)
        id='ms%d'%sid; z.writestr('files/%s.pdf'%id,data); sizes[id]=page_sizes(data)
        t,a,v=split_name(title)
        songs.append({'id':id,'title':filename(t,a,v)[:-4],'song':t,'artist':a,'version':v,'file':filename(t,a,v),'pages':pages,'added':created or 0})
    known={x['id'] for x in songs}
    tb={r[0]:r[1:] for r in c.execute('select BaseId,Text,FontSize,TextColor from TextboxAnnotations')}
    for bid,sid,typ,page,sw,sh,op,pts,col,lw in c.execute('''select b.Id,b.SongId,b.Type,b.Page,b.SourcePageWidth,b.SourcePageHeight,b.Opacity,p.Points,d.LineColor,d.LineWidth
      from AnnotationsBase b left join AnnotationPoints p on p.AnnotationId=b.Id left join DrawAnnotations d on d.BaseId=b.Id order by b.Id''').fetchall():
        if 'ms%d'%sid not in known: continue
        if typ==0:
            rep['textboxes']+=1; text,fs,tcol=tb.get(bid,('',0,None))
            if not (text or '').strip() or not pts: rep['textboxes_blank']+=1; continue
            (x1,y1)=parse_points(pts,0)[0][1][0]
            ink.setdefault('ms%d:%d'%(sid,page+1),[]).append({'t':'text','id':'msnote%d'%bid,'x':round(x1/sw,4),'y':round(y1/sh,4),
              'text':text.strip('\n'),'size':round(fs/sw,5),'c':hexcol(tcol)})
            rep['textboxes_converted']+=1; continue
        if typ==3: rep['stamps']+=1; continue
        if not pts: continue
        for w,xy in parse_points(pts,typ):
            ink.setdefault('ms%d:%d'%(sid,page+1),[]).append({'t':'hl' if (op or 100)<100 else 'pen','c':hexcol(col),
              'w':round((w or lw or 1)/sw,5),'p':[[round(x/sw,4),round(y/sh,4)] for x,y in xy]})
    crow=c.execute('select SongId,Page,Left,Top,Right,Bottom from Crop').fetchall()
    rep['crop_rows_total']=len(crow)
    crops=convert_crops(crow,sizes,known,rep)
    rep['crop_rows_with_a_crop']=sum((1 if v['all'] else 0)*len(sizes[k])+len(v['pages']) for k,v in crops.items())
    for s_ in songs:
        if s_['id'] in crops: s_['crop']=crops[s_['id']]
    # A setlist entry whose song has no file (MobileSheets' "Set 2" / "Set 3" placeholders) becomes a break named after that song.
    sets=[]
    for i,n,cr in c.execute('select Id,Name,DateCreated from Setlists order by Id').fetchall():
        items=[];brk=[]
        for (sid,) in c.execute('select SongId from SetlistSong where SetlistId=? order by Id',(i,)):
            if 'ms%d'%sid in known: items.append({'type':'song','id':'ms%d'%sid})
            elif sid in nofile: brk.append(nofile[sid]); items.append({'type':'break','id':'msbrk%d_%d'%(i,len(brk)),'name':nofile[sid]})
        if brk: rep['breaks'][n]=brk
        sets.append({'id':'msset%d'%i,'name':n,'created':cr or 0,'items':items})
    z.writestr('library.json',json.dumps({'app':'setlist-stand','version':2,'saved':'from MobileSheets','songs':songs,'sets':sets,'ink':ink}))
    z.close(); os.unlink(tmp.name)
    rep.update(songs=len(songs),setlists=len(sets),annotated_pages=len(ink)); print(json.dumps(rep,indent=1))
if __name__=='__main__': main(*sys.argv[1:3])
