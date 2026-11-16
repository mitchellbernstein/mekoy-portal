import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const input=JSON.parse(await readFile('/input/chapter.json','utf8'));
const mode=process.argv[2];
const extract=`import json, os, pathlib, shutil, tarfile
root=pathlib.Path('/app')
data=json.load(open('/input/chapter.json'))
with tarfile.open('/input/source.tar.gz','r:gz') as archive:
    if archive.pax_headers.get('comment') != data['commitSha']:
        raise RuntimeError('Archive commit ID does not match the queued exact commit')
    members=archive.getmembers()
    if len(members)>100000 or sum(m.size for m in members)>536870912:
        raise RuntimeError('Repository archive exceeds the extraction budget')
    first={pathlib.PurePosixPath(m.name).parts[0] for m in members if pathlib.PurePosixPath(m.name).parts}
    prefix=next(iter(first)) if len(first)==1 and any('/' in m.name for m in members) else None
    for member in members:
        name=pathlib.PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or '\\\\' in member.name or not (member.isfile() or member.isdir()):
            raise RuntimeError('Source archive contains an unsafe path or unsupported link')
        parts=name.parts[1:] if prefix else name.parts
        if not parts: continue
        target=root.joinpath(*parts)
        if member.isdir(): target.mkdir(parents=True,exist_ok=True); continue
        target.parent.mkdir(parents=True,exist_ok=True)
        with archive.extractfile(member) as source, open(target,'xb') as destination:
            shutil.copyfileobj(source,destination)
        target.chmod(0o755 if member.mode & 0o111 else 0o644)
manifest=json.load(open('/app/.video-workspace/demo.json'))
if manifest != data['manifest']:
    raise RuntimeError('Checked-out startup manifest differs from the approved source evidence')
if data['manifest'].get('install'):
    import re, urllib.parse
    def check(value):
        if isinstance(value,dict):
            for child in value.values(): check(child)
        elif isinstance(value,str) and (re.search(r'(?:https?:|git(?:[+:])|file:|link:|ssh:|github:)',value) or value.startswith(('.', '/','~/')) or ('/' in value and not value.startswith('npm:@'))):
            raise RuntimeError('The isolated npm profile excludes remote, Git, and out-of-tree dependency specifications')
    if (root/'npm-shrinkwrap.json').exists():
        raise RuntimeError('The isolated npm profile requires package-lock.json version 3, not npm-shrinkwrap.json')
    lock=json.load(open(root/'package-lock.json'))
    if lock.get('lockfileVersion') != 3 or not isinstance(lock.get('packages'),dict):
        raise RuntimeError('The isolated npm profile requires a version 3 package-lock.json')
    for name,package in lock['packages'].items():
        for field in ('dependencies','devDependencies','optionalDependencies','peerDependencies','overrides'): check(package.get(field,{}))
        if not name: continue
        value=package.get('resolved')
        if package.get('link'):
            local=pathlib.PurePosixPath(value or '')
            if not value or local.is_absolute() or '..' in local.parts or ':' in value:
                raise RuntimeError('Workspace links must stay inside the extracted repository')
            continue
        if value is None and (package.get('inBundle') or not name.startswith('node_modules/')): continue
        url=urllib.parse.urlsplit(value or '')
        if url.scheme!='https' or url.hostname!='registry.npmjs.org' or url.port is not None or url.username or url.password or url.query or url.fragment or not re.fullmatch(r'/(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+/-/[A-Za-z0-9_.-]+\\.tgz',url.path):
            raise RuntimeError('Dependencies must use credential-free official registry.npmjs.org tarball URLs')
        if not re.fullmatch(r'sha(?:1|256|512)-[A-Za-z0-9+/=]+',package.get('integrity','')):
            raise RuntimeError('Registry dependencies need a pinned package integrity hash')
    for current,dirs,files in os.walk(root):
        dirs[:]=[name for name in dirs if name!='node_modules']
        if '.npmrc' in files: pathlib.Path(current,'.npmrc').unlink()
        if 'package.json' not in files: continue
        package=json.load(open(pathlib.Path(current,'package.json')))
        for field in ('dependencies','devDependencies','optionalDependencies','peerDependencies','overrides'):
            check(package.get(field,{}))
    pathlib.Path('/tmp/video-workspace-global-npmrc').write_text('')
print('Source commit and startup manifest verified')
`;
let child;
function execute(argv,timeout) {
  return new Promise((resolve,reject)=>{
    child=spawn(argv[0],argv.slice(1),{cwd:'/app',stdio:'inherit',detached:true,env:{PATH:process.env.PATH,HOME:'/tmp',NODE_ENV:'development',NPM_CONFIG_CACHE:'/tmp/npm-cache',PORT:String(input.manifest.port),HOST:'0.0.0.0'}});
    const timer=setTimeout(()=>{try {process.kill(-child.pid,'SIGTERM');} catch {}reject(new Error('Repository command exceeded the isolated runtime limit'));},timeout);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);child=undefined;code===0?resolve():reject(new Error(`Repository command failed (${code ?? signal})`));});
  });
}
function stop(signal) {if(child) try {process.kill(-child.pid,signal);} catch {}process.exit(0);}
process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
if (mode==='setup') {
  await execute(['python3','-c',extract],30_000);
  if(input.manifest.install) {
    if(JSON.stringify(input.manifest.install)!==JSON.stringify(['npm','ci'])) throw new Error('The isolated first-build profile supports install ["npm","ci"]. Package lifecycle scripts run later without network access');
    await execute(['npm','ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org','--userconfig=/dev/null','--globalconfig=/tmp/video-workspace-global-npmrc'],240_000);
    await rm('/tmp/npm-cache',{recursive:true,force:true});
  }
} else if(mode==='build') {
  if(input.manifest.install) await execute(['npm','rebuild','--offline'],180_000);
  if(input.manifest.build) await execute(input.manifest.build,240_000);
} else if(mode==='start') await execute(input.manifest.start,40*60_000);
else throw new Error('Choose setup, build, or start');
