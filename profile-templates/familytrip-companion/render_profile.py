#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json,os,re,shutil,subprocess,sys,tempfile
from datetime import datetime,timezone
from pathlib import Path
from string import Template
ROOT=Path(__file__).resolve().parent
FORBIDDEN=re.compile(r'(?:^|_)(?:token|password|secret|api_?key|bot_?token|confirmation_code)(?:$|_)',re.I)
# `gender` is required and validated, but it used to reach only
# references/group-context.json — nothing in the prompt said which forms the
# assistant uses about ITSELF, so it took the cue from how its own name sounds.
# In Hebrew that is wrong in every first-person sentence, not occasionally.
GENDER_RULE={
 'male':'You are {name}, and you speak about yourself in the **masculine**. In Hebrew: «אני בודק», «שמח לעזור», «הייתי שם» — never the feminine forms.',
 'female':'You are {name}, and you speak about yourself in the **feminine**. In Hebrew: «אני בודקת», «שמחה לעזור», «הייתי שם» — never the masculine forms.',
 'neutral':'You are {name}, and you avoid gendering yourself. Hebrew has no neuter, so reach for phrasings that do not force a choice — «אבדוק» rather than «אני בודק/בודקת», a noun where a participle would commit you. Do not alternate between masculine and feminine forms: that reads as a mistake rather than as neutrality, and do not write «בודק/ת» either.',
}
# `tone` is required and validated exactly like `gender`, but until now it
# only reached references/group-context.json as inert JSON — nothing in the
# prompt told the assistant to actually speak that way, so every companion
# read the same as "warm" regardless of what was chosen.
TONE_RULE={
 'warm':'Speak warmly: encouraging and personable, a little emotionally present — "that sounds like a great plan" rather than a flat confirmation. Still concise; the warmth is in the word choice, not the length.',
 'playful':'Speak playfully: light and upbeat, comfortable with a bit of humor or an emoji where it fits naturally. Stay useful first — playful is the seasoning, not the answer.',
 'dry':'Speak dryly: understated and efficient, mostly just the facts. Skip enthusiasm and filler ("Great question!", "Happy to help!"); a flash of dry wit is fine, gushing is not.',
}
def bad(m): raise ValueError(m)
def scan(v,path='$'):
 if isinstance(v,dict):
  for k,x in v.items():
   if FORBIDDEN.search(str(k)): bad(f'secret-like key is not allowed in handoff: {path}.{k}')
   scan(x,f'{path}.{k}')
 elif isinstance(v,list):
  for i,x in enumerate(v): scan(x,f'{path}[{i}]')
def validate(d):
 req={'schema_version','record_type','handoff_id','trip_ref','source','profile','trip','assistant','organizer','interview'}
 if req-set(d): bad(f'missing top-level keys: {sorted(req-set(d))}')
 if set(d)-req: bad(f'unknown top-level keys: {sorted(set(d)-req)}')
 if d['schema_version']!=1 or d.get('record_type')!='trip_assistant_profile_input': bad('invalid profile input contract')
 if d['interview'].get('confirmed') is not True: bad('interview must be organizer-confirmed')
 if 'raw_intake' in d['interview']: bad('raw intake must remain outside the portable normalized profile input')
 n=d['profile'].get('name','')
 if not re.fullmatch(r'[a-z][a-z0-9]{2,31}',n): bad('invalid Hermes profile name')
 for sec,keys in {'trip':('id','title','default_language','timezone','canonical_site_url'),'assistant':('name','gender','tone'),'organizer':('person_ref','display_name')}.items():
  if [k for k in keys if not d[sec].get(k)]: bad(f'missing required fields in {sec}')
 if d['trip']['default_language'] not in {'he','en'}: bad('invalid language')
 if d['assistant']['gender'] not in {'male','female','neutral'}: bad('invalid gender')
 if d['assistant']['tone'] not in {'warm','playful','dry'}: bad('invalid tone')
 if not re.match(r'^https?://',d['trip']['canonical_site_url']): bad('site URL must be http(s)')
 scan(d)
def tpl(p,v): return Template(p.read_text()).substitute(v)
def render(d,out):
 validate(d)
 if out.exists() and any(out.iterdir()): bad(f'output is not empty: {out}')
 out.mkdir(parents=True,exist_ok=True); t=d['trip']; a=d['assistant']; o=d['organizer']
 v={'PROFILE_NAME':d['profile']['name'],'PROFILE_DESCRIPTION_JSON':json.dumps(d['profile'].get('description') or f"Trip companion for {t['title']}",ensure_ascii=False),'TRIP_TITLE':t['title'],'SITE_URL':t['canonical_site_url'],'TIMEZONE':t['timezone'],'ASSISTANT_NAME':a['name'],'ASSISTANT_GENDER_RULE':GENDER_RULE[a['gender']].replace('{name}',a['name']),'ASSISTANT_TONE_RULE':TONE_RULE[a['tone']],'ORGANIZER_NAME':o['display_name'],'ORGANIZER_REF':o['person_ref'],'SITE_CONNECTION_NAME':t.get('site_connection_name') or 'trip-mcp'}
 for src,dst in [('SOUL.md.tpl','SOUL.md'),('profile.yaml.tpl','profile.yaml'),('config.overlay.yaml.tpl','config.overlay.yaml')]: (out/dst).write_text(tpl(ROOT/'templates'/src,v))
 (out/'references').mkdir(); (out/'references/sources.md').write_text(tpl(ROOT/'templates/references/sources.md.tpl',v)); shutil.copytree(ROOT/'templates/skills',out/'skills',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
 group={'schema_version':1,'trip':{k:t[k] for k in ('id','title','default_language','timezone')},'assistant':a,'preferences':d['interview'].get('group_safe',{})}
 private={'schema_version':1,'handoff_id':d['handoff_id'],'trip_ref':d['trip_ref'],'organizer':o,'organizer_private':d['interview'].get('organizer_private',{}),'participant_needs':d['interview'].get('participant_needs',[]),'source':d['source']}
 (out/'references/group-context.json').write_text(json.dumps(group,indent=2,ensure_ascii=False)+'\n'); (out/'references/interview-context.private.json').write_text(json.dumps(private,indent=2,ensure_ascii=False)+'\n')
 (out/'INSTALL.md').write_text('# Install '+d['profile']['name']+'\n\nCreate a fresh profile, copy this overlay, deliberately merge config.overlay.yaml, configure secrets securely, verify live reads/privacy/write read-back, then start the gateway.\n\nBefore starting the gateway: read profile-templates/familytrip-companion/README.md "Register with trip-intake" and profile-templates/trip-intake-interviewer/README.md "Doubling as the shared trip-companion host" to check whether trip-intake multiplexing is safe to use yet on this Hermes install. If not, give "'+d['profile']['name']+'" its own dedicated gateway and bot token instead of waiting on trip-intake to route to it.\n')
# What a render owns inside a profile, and nothing else. state.db, memories/, sessions/, logs/, .env, config.yaml
# (beyond the installer's overlay merge), the managed marker and the write sandbox are the profile's own: a re-render
# never reads, writes or deletes them.
MANAGED_FILES=('SOUL.md','profile.yaml','INSTALL.md','config.overlay.yaml')
MANAGED_DIRS=('references','skills')
MANIFEST='.kinerary-render.json'   # digest of every file the last render wrote: what "edited in place" is measured against
CLEAN,EDITED,UNKNOWN,APPLIED,UNCHANGED='clean','edited','unknown_provenance','applied','unchanged'
RELEASE_ID=re.compile(r'^[A-Za-z0-9_.-]{1,80}$'); COMMIT=re.compile(r'^[a-f0-9]{40}$'); SHOWABLE=re.compile(r'^[A-Za-z0-9._/-]{1,200}$')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def managed_path(rel):
 """A relative path a render could have written: inside the managed set, no way out of it."""
 if not isinstance(rel,str) or not rel or rel.startswith('/') or '\\' in rel or '\0' in rel: return False
 parts=rel.split('/')
 if any(x in ('','.','..') for x in parts): return False
 return (len(parts)==1 and rel in MANAGED_FILES) or (len(parts)>1 and parts[0] in MANAGED_DIRS)
def rendered_files(bundle):
 """rel path -> sha256 of every file a render put in `bundle` that the profile will hold."""
 out={}
 for rel in MANAGED_FILES:
  if (bundle/rel).is_file(): out[rel]=sha(bundle/rel)
 for d in MANAGED_DIRS:
  for p in sorted((bundle/d).rglob('*')) if (bundle/d).is_dir() else []:
   if p.is_file() and not p.is_symlink(): out[str(p.relative_to(bundle))]=sha(p)
 return out
def write_atomic(dst,data,mode):
 """Replace `dst` with `data` without ever writing through a symlink: the new file is made beside it and renamed over it."""
 fd,tmp=tempfile.mkstemp(dir=dst.parent,prefix='.render-')
 try:
  with os.fdopen(fd,'wb') as f: f.write(data)
  os.chmod(tmp,mode); os.replace(tmp,dst)
 except BaseException:
  try: os.unlink(tmp)
  except OSError: pass
  raise
def file_mode(dst,src):
 """The profile's own mode for a file it already has (a re-render does not widen what the account narrowed), else the
 render's, and never group- or world-readable for the organizer-private context."""
 mode=dst.stat().st_mode&0o777 if dst.is_file() and not dst.is_symlink() else src.stat().st_mode&0o777
 return mode&0o700 if '.private.' in src.name else mode
def write_manifest(home,files,release=None):
 doc={'schema':1,'rendered_at':datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'release':release,'files':files}
 write_atomic(home/MANIFEST,(json.dumps(doc,indent=2,sort_keys=True)+'\n').encode(),0o600)
def read_manifest(home):
 """The record of the last render, or None when it is absent or is not one — an older profile, or a damaged record."""
 p=home/MANIFEST
 try:
  if p.is_symlink() or not p.is_file(): return None
  doc=json.loads(p.read_text())
 except (OSError,ValueError): return None
 if not isinstance(doc,dict) or doc.get('schema')!=1: return None
 files=doc.get('files')
 if not isinstance(files,dict): return None
 if not all(managed_path(k) and isinstance(v,str) and re.fullmatch(r'[a-f0-9]{64}',v) for k,v in files.items()): return None
 return files
def recorded_release(home):
 try: return json.loads((home/MANIFEST).read_text()).get('release')
 except (OSError,ValueError,AttributeError): return None
def physical_parent_ok(home,rel):
 """No directory between the profile and `rel` is a symlink: a write there would land somewhere else."""
 cur=home
 for part in rel.split('/')[:-1]:
  cur=cur/part
  if cur.is_symlink(): return False
 return True
def assess(home,new):
 """(status, edited rel paths). clean = every file the last render wrote is as it wrote it, and the new render
 would write over nothing that was not its own."""
 old=read_manifest(home)
 if old is None: return UNKNOWN,[]
 edited=[]
 for rel,want in old.items():
  p=home/rel
  if not physical_parent_ok(home,rel) or p.is_symlink() or not p.is_file() or sha(p)!=want: edited.append(rel)
 for rel in new:
  if rel not in old and (home/rel).exists(): edited.append(rel)   # it would replace something the render never wrote
 return (EDITED if edited else CLEAN),sorted(set(edited))
def back_up(home,backup_root,name,rels):
 """Copy `rels` (those that exist, as plain files) aside, under <backup_root>/<name>/<utc stamp>/, owner-only."""
 dest=Path(backup_root)/name/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
 old_umask=os.umask(0o077)
 try:
  dest.mkdir(parents=True,exist_ok=False)
  for rel in rels:
   src=home/rel
   if not physical_parent_ok(home,rel) or src.is_symlink() or not src.is_file(): continue
   (dest/rel).parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dest/rel)
 finally: os.umask(old_umask)
 os.chmod(dest,0o700)
 prune_backups(dest.parent)
 return dest
KEEP_BACKUPS=3
def prune_backups(parent,keep=KEEP_BACKUPS):
 """Keep the newest `keep` backups of a profile and delete the rest. A backup holds the organizer-private context, so
 they are not kept for ever; only directories this module names (a UTC stamp) are ever deleted, never a link."""
 stamps=sorted(p for p in parent.iterdir() if re.fullmatch(r'[0-9]{8}T[0-9]{12}Z',p.name) and p.is_dir() and not p.is_symlink())
 for old in stamps[:-keep] if keep else stamps: shutil.rmtree(old,ignore_errors=True)
def reinstall(bundle,name,allow_edited=False,check_only=False,backup_root=None,release=None):
 """Bring an existing profile's RENDERED files to `bundle`, in place. Returns (verdict dict, exit code):
 0 done or nothing to do, 3 refused because the profile was edited in place or its provenance is unknown."""
 home=Path.home()/'.hermes/profiles'/name
 if home.is_symlink() or not home.is_dir(): bad(f'no profile {name} to re-render (it is created by --install-profile, never here)')
 new=rendered_files(bundle)
 old=read_manifest(home) or {}
 # Files the record lists that this render does not produce are deleted by an apply. The record cannot say whether a
 # release ever rendered them (a render of the old release is not available here), so they are always copied aside first.
 gone=[rel for rel in sorted(set(old)-set(new)) if physical_parent_ok(home,rel) and ((home/rel).is_file() or (home/rel).is_symlink())]
 status,edited=assess(home,new)
 shown=[e for e in edited if SHOWABLE.match(e)][:20]
 verdict={'status':status,'edited':shown,'edited_total':len(edited),'removed_names':[g for g in gone if SHOWABLE.match(g)][:20]}
 if check_only: return verdict,(0 if status==CLEAN else 3)
 if status!=CLEAN and not allow_edited: return verdict,3
 if not check_only and (allow_edited or gone) and not backup_root: bad('an apply that replaces an edited file or deletes one needs --backup-root: it is copied aside first')
 if status!=CLEAN:
  # Capture first (CLAUDE.md, "Hermes skills: capture before you deploy"): every rendered file the profile holds now.
  verdict['backup']=str(back_up(home,backup_root,name,sorted(set(new)|set(old)|set(edited)|set(k for k in MANAGED_FILES))))
 elif gone: verdict['backup']=str(back_up(home,backup_root,name,gone))
 written=removed=0
 for rel,want in new.items():
  dst=home/rel
  if not physical_parent_ok(home,rel) or (dst.parent.is_symlink()): bad(f'{rel} sits behind a symlink; refusing to write through it')
  if dst.is_file() and not dst.is_symlink() and sha(dst)==want: continue
  if not dst.parent.exists(): dst.parent.mkdir(parents=True,exist_ok=True)
  write_atomic(dst,(bundle/rel).read_bytes(),file_mode(dst,bundle/rel)); written+=1
 for rel in sorted(set(old)-set(new)):
  dst=home/rel
  if physical_parent_ok(home,rel) and (dst.is_file() or dst.is_symlink()): dst.unlink(); removed+=1
 for d in MANAGED_DIRS:   # a skill directory a release stopped rendering goes when it is empty, never otherwise
  for p in sorted((home/d).rglob('*'),reverse=True) if (home/d).is_dir() and not (home/d).is_symlink() else []:
   if p.is_dir() and not p.is_symlink() and not any(p.iterdir()): p.rmdir()
 if status==CLEAN and not written and not removed: verdict['status']=UNCHANGED
 else: verdict['status']=APPLIED
 verdict.update(written=written,removed=removed)
 # An unchanged profile is left exactly as it is: the record is rewritten only when something moved or the release it
 # names did (a new release whose templates render identically still has to say which release the profile follows).
 if verdict['status']==APPLIED or recorded_release(home)!=release: write_manifest(home,new,release)
 return verdict,0
def install(bundle,name,release=None):
 home=Path.home()/'.hermes/profiles'/name
 if home.exists(): bad(f'refusing to overwrite existing profile: {home}')
 subprocess.run(['hermes','profile','create',name,'--no-skills','--description',f'Trip companion for {name}'],check=True)
 # Hermes 2026.9.24's `profile create` seeds the NEW profile's config.yaml with the host root profile's `model:` block.
 # The overlay merge (scripts/companion-install-host.sh) lets an existing config win, so the seed beat the template's
 # model: the real Alsace companion ran the root's anthropic/claude-opus-4.6 with no Anthropic credentials, Mac
 # companions got haiku or gpt-5.6-luna. Nothing here has been written by a person or an earlier install (the refusal
 # above means this directory did not exist a moment ago), so whatever config.yaml is in it IS the seed, and goes: "the
 # existing config wins" then only ever means a config somebody wrote. A missing config.yaml is the state the merge
 # already handles (it writes the overlay).
 seeded=home/'config.yaml'
 if seeded.is_symlink() or seeded.is_file(): seeded.unlink()
 for rel in ('SOUL.md','profile.yaml','references','skills','INSTALL.md','config.overlay.yaml'):
  s=bundle/rel; q=home/rel
  shutil.copytree(s,q,dirs_exist_ok=True) if s.is_dir() else shutil.copy2(s,q)
 write_manifest(home,rendered_files(bundle),release)
def main():
 p=argparse.ArgumentParser(); p.add_argument('--input',required=True,type=Path); p.add_argument('--output',required=True,type=Path); p.add_argument('--install-profile')
 p.add_argument('--reinstall-profile',help='re-render an EXISTING profile in place: replaces the files a render owns and nothing else')
 p.add_argument('--check',action='store_true',help='with --reinstall-profile: say whether it could be re-rendered, write nothing')
 p.add_argument('--allow-edited',action='store_true',help='with --reinstall-profile: overwrite a profile edited in place (or of unknown provenance), after copying it aside')
 p.add_argument('--backup-root',type=Path); p.add_argument('--release-id'); p.add_argument('--release-commit')
 x=p.parse_args()
 if x.install_profile and x.reinstall_profile: p.error('--install-profile and --reinstall-profile are different requests')
 if (x.check or x.allow_edited or x.backup_root) and not x.reinstall_profile: p.error('--check, --allow-edited and --backup-root belong to --reinstall-profile')
 if x.release_id is not None and not RELEASE_ID.match(x.release_id): bad('--release-id is not a release id')
 if x.release_commit is not None and not COMMIT.match(x.release_commit): bad('--release-commit is not a 40-hex commit')
 release={'id':x.release_id,'commit':x.release_commit} if x.release_id and x.release_commit else None
 d=json.loads(x.input.read_text()); render(d,x.output)
 if x.reinstall_profile:
  if x.reinstall_profile!=d['profile']['name']: bad('--reinstall-profile must match profile.name')
  verdict,code=reinstall(x.output,x.reinstall_profile,x.allow_edited,x.check,x.backup_root,release)
  print(json.dumps(verdict,sort_keys=True)); raise SystemExit(code)
 if x.install_profile:
  if x.install_profile!=d['profile']['name']: bad('--install-profile must match profile.name')
  install(x.output,x.install_profile,release)
 print(x.output)
if __name__=='__main__':
 try: main()
 except (ValueError,json.JSONDecodeError,subprocess.CalledProcessError) as e: print('ERROR:',e,file=sys.stderr); raise SystemExit(2)
