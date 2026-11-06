"""Import the owner's lawfully obtained local model, without redistributing it. Requires Pillow."""
from pathlib import Path
import argparse, json, shutil, hashlib
from PIL import Image
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',required=True,help='Folder containing the model3 JSON and original resources')
parser.add_argument('--accept-model-license',action='store_true')
parser.add_argument('--license-file',help='Original author license if it is outside the model directory')
args=parser.parse_args()
if not args.accept_model_license: parser.error('Read the model author license first, then pass --accept-model-license for your own local use.')
root=Path(__file__).resolve().parents[1];source=Path(args.source).resolve();candidates=list(source.glob('*.model3.json'))
if len(candidates)!=1: parser.error('The source folder must contain exactly one model3.json')
licenses=[Path(args.license_file).resolve()] if args.license_file else [*source.glob('*LICENSE*.txt'),*source.glob('*使用须知*.txt'),*source.parent.glob('*使用须知*.txt')]
if not licenses or not licenses[0].is_file(): parser.error('Provide the original author license with --license-file; the importer will preserve it.')
target=root/'phone-brain/model/deepseek-chan'
if target.exists(): parser.error('Target model already exists. Preserve it and choose a clean checkout; this importer will not overwrite it.')
data=json.loads(candidates[0].read_text(encoding='utf-8-sig'))
refs=data.get('FileReferences',{}); textures=refs.get('Textures',[])
for name in [refs.get('Moc'),*textures]:
    if not name: continue
    p=(source/name).resolve()
    if not p.is_relative_to(source) or not p.is_file(): parser.error('Model references a missing or out-of-folder file')
shutil.copytree(source,target)
for name in textures:
    p=target/name
    with Image.open(p) as original:
        image=original.convert('RGBA');image.thumbnail((2048,2048),Image.Resampling.LANCZOS);image.save(p)
expressions=[]
for expression in sorted((target/'Exp3').glob('*.exp3.json')):
    expressions.append({'Name':expression.name.removesuffix('.exp3.json'),'File':'Exp3/'+expression.name})
if expressions: refs['Expressions']=expressions
motions={'Idle':'IDLE','RaiseHand':'默认手切举手','LowerHand':'举手切默认手','Grass':'狗尾草切换出来','GrassOff':'狗尾草切回默认手','Point':'竖手指切出来动画','PointOff':'竖手指切回默认','LostTracking':'脱捕'}
groups={}
for group,name in motions.items():
    relative='Animation/'+name+'.motion3.json';file=target/relative
    if not file.is_file(): continue
    motion=json.loads(file.read_text(encoding='utf-8-sig'));motion.setdefault('Meta',{})['Loop']=group=='Idle';file.write_text(json.dumps(motion,ensure_ascii=False),encoding='utf-8')
    groups[group]=[{'File':relative,'FadeInTime':.22,'FadeOutTime':.3}]
if groups: refs['Motions']=groups
for group in data.get('Groups',[]):
    if group.get('Name')=='LipSync': group['Ids']=['ParamMouthOpenY']
display={}
if refs.get('DisplayInfo'): display=json.loads((target/refs['DisplayInfo']).read_text(encoding='utf-8-sig'))
interaction={'version':2,'modelId':'local-deepseek-chan','render':{'clippingMaskSize':1024,'sourceModified':False},'expressions':{e['Name']:json.loads((target/e['File']).read_text(encoding='utf-8-sig'))['Parameters'] for e in refs.get('Expressions',[])},'parts':{p['Id']:p['Name'] for p in display.get('Parts',[])},'parameters':{p['Id']:p['Name'] for p in display.get('Parameters',[])},'motions':list(groups)}
(target/'interaction.json').write_text(json.dumps(interaction,ensure_ascii=False,indent=2),encoding='utf-8')
shutil.copy2(licenses[0],target/'LICENSE.txt')
(target/'credits.json').write_text(json.dumps({'name':'DeepSeek-chan（大肥鱼）','art':'神宫凉子','rig':'霓虹猫_NeonNeko','usage':'Original author license applies. Local self-use only; do not redistribute the full model or an APK containing it.'},ensure_ascii=False,indent=2),encoding='utf-8')
# Keep the APK's known entry name; internal references remain the author's relative files.
entry=target/'大肥鱼.model3.json'
entry.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
avatar={'mode':'live2d','modelId':'local-deepseek-chan','version':hashlib.sha256(entry.read_bytes()).hexdigest()[:12], 'url':'/model/deepseek-chan/大肥鱼.model3.json','zoom':1.03,'offsetY':-.055}
(target.parent/'avatar.json').write_text(json.dumps(avatar,ensure_ascii=False,indent=2),encoding='utf-8')
native=root/'apk/assets/model'
if native.exists(): parser.error('APK assets/model already exists; do not overwrite. The server import is complete.')
shutil.copytree(target.parent,native)
print('Imported for local self-use; copied the author license and reduced only the local texture copies. Do not publish this model or an APK containing it.')
