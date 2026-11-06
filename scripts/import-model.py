"""Import the owner's lawfully obtained local model, without redistributing it. Requires Pillow."""
from pathlib import Path
import argparse, json, shutil, hashlib
from PIL import Image
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',required=True,help='Folder containing the model3 JSON and original resources')
parser.add_argument('--accept-model-license',action='store_true')
args=parser.parse_args()
if not args.accept_model_license: parser.error('Read the model author license first, then pass --accept-model-license for your own local use.')
root=Path(__file__).resolve().parents[1];source=Path(args.source).resolve();candidates=list(source.glob('*.model3.json'))
if len(candidates)!=1: parser.error('The source folder must contain exactly one model3.json')
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
# Keep the APK's known entry name; internal references remain the author's relative files.
entry=target/'大肥鱼.model3.json'
if candidates[0].name!=entry.name: shutil.copy2(target/candidates[0].name,entry)
avatar={'mode':'live2d','modelId':'local-deepseek-chan','version':hashlib.sha256(entry.read_bytes()).hexdigest()[:12], 'url':'/model/deepseek-chan/大肥鱼.model3.json','zoom':1.03,'offsetY':-.055}
(target.parent/'avatar.json').write_text(json.dumps(avatar,ensure_ascii=False,indent=2),encoding='utf-8')
native=root/'apk/assets/model'
if native.exists(): parser.error('APK assets/model already exists; do not overwrite. The server import is complete.')
shutil.copytree(target.parent,native)
print('Imported for local self-use; copied the author license and reduced only the local texture copies. Do not publish this model or an APK containing it.')
