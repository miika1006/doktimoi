import json,time,importlib.metadata,sys
from pathlib import Path
from rapidocr import RapidOCR
p=Path(sys.argv[1])
if (p/'rapid-results.json').exists(): raise RuntimeError('Refusing existing results')
truth=json.loads((p/'truth.json').read_text())
t=time.perf_counter()
e=RapidOCR(params={'Global.log_level':'warning','Rec.lang_type':'fi','EngineConfig.onnxruntime.intra_op_num_threads':1,'EngineConfig.onnxruntime.inter_op_num_threads':1})
setup=(time.perf_counter()-t)*1000
out=[]
for fixture in ['normal','small','skew','rotated']:
    for run in range(3):
        t=time.perf_counter();r=e(str(p/(fixture+'.png')));ms=(time.perf_counter()-t)*1000
        lines=list(r.txts or []);text='\n'.join(lines)
        norm=lambda s:' '.join(s.split())
        critical=[{'value':v,'pass':norm(v) in norm(text)} for v in truth['critical']]
        # Detector returns individual cell boxes; group cells by y-center within half their median height.
        boxes=r.boxes.tolist() if r.boxes is not None else []
        groups=[]
        for box,line in sorted(zip(boxes,lines),key=lambda x:sum(q[1] for q in x[0])/4):
            y=sum(q[1] for q in box)/4;h=max(q[1] for q in box)-min(q[1] for q in box)
            if groups and abs(y-groups[-1]['y'])<h*.5:groups[-1]['text']+=' '+line
            else:groups.append({'y':y,'text':line})
        rows=[{'values':vs,'pass':any(all(norm(v) in norm(g['text']) for v in vs) for g in groups)} for vs in truth['rows']]
        result={'engine':'rapidocr '+importlib.metadata.version('rapidocr'),'onnxruntime':importlib.metadata.version('onnxruntime'),'fixture':fixture,'run':run,'setupMs':setup,'ms':ms,'criticalPassed':sum(x['pass'] for x in critical),'criticalTotal':len(critical),'rowsPassed':sum(x['pass'] for x in rows),'rowsTotal':len(rows),'critical':critical,'rows':rows,'text':text,'boxes':boxes,'groups':groups}
        out.append(result);print(json.dumps(result,ensure_ascii=False),flush=True)
(p/'rapid-results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
