#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,re,shutil,subprocess,sys
from pathlib import Path
from string import Template
ROOT=Path(__file__).resolve().parent
FORBIDDEN=re.compile(r'(?:^|_)(?:token|password|secret|api_?key|bot_?token|confirmation_code)(?:$|_)',re.I)
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
 v={'PROFILE_NAME':d['profile']['name'],'PROFILE_DESCRIPTION_JSON':json.dumps(d['profile'].get('description') or f"Trip companion for {t['title']}",ensure_ascii=False),'TRIP_TITLE':t['title'],'SITE_URL':t['canonical_site_url'],'TIMEZONE':t['timezone'],'ASSISTANT_NAME':a['name'],'ORGANIZER_NAME':o['display_name'],'ORGANIZER_REF':o['person_ref'],'SITE_CONNECTION_NAME':t.get('site_connection_name') or 'trip-site'}
 for src,dst in [('SOUL.md.tpl','SOUL.md'),('profile.yaml.tpl','profile.yaml'),('config.overlay.yaml.tpl','config.overlay.yaml')]: (out/dst).write_text(tpl(ROOT/'templates'/src,v))
 (out/'references').mkdir(); (out/'references/sources.md').write_text(tpl(ROOT/'templates/references/sources.md.tpl',v)); shutil.copytree(ROOT/'templates/skills',out/'skills')
 group={'schema_version':1,'trip':{k:t[k] for k in ('id','title','default_language','timezone')},'assistant':a,'preferences':d['interview'].get('group_safe',{})}
 private={'schema_version':1,'handoff_id':d['handoff_id'],'trip_ref':d['trip_ref'],'organizer':o,'organizer_private':d['interview'].get('organizer_private',{}),'participant_needs':d['interview'].get('participant_needs',[]),'source':d['source']}
 (out/'references/group-context.json').write_text(json.dumps(group,indent=2,ensure_ascii=False)+'\n'); (out/'references/interview-context.private.json').write_text(json.dumps(private,indent=2,ensure_ascii=False)+'\n')
 (out/'INSTALL.md').write_text('# Install '+d['profile']['name']+'\n\nCreate a fresh profile, copy this overlay, deliberately merge config.overlay.yaml, configure secrets securely, verify live reads/privacy/write read-back, then start the gateway.\n\nBefore starting the gateway: read profile-templates/familytrip-companion/README.md "Register with trip-intake" and profile-templates/trip-intake-interviewer/README.md "Doubling as the shared trip-companion host" to check whether trip-intake multiplexing is safe to use yet on this Hermes install. If not, give "'+d['profile']['name']+'" its own dedicated gateway and bot token instead of waiting on trip-intake to route to it.\n')
def install(bundle,name):
 home=Path.home()/'.hermes/profiles'/name
 if home.exists(): bad(f'refusing to overwrite existing profile: {home}')
 subprocess.run(['hermes','profile','create',name,'--no-skills','--description',f'Trip companion for {name}'],check=True)
 for rel in ('SOUL.md','profile.yaml','references','skills','INSTALL.md','config.overlay.yaml'):
  s=bundle/rel; q=home/rel
  shutil.copytree(s,q,dirs_exist_ok=True) if s.is_dir() else shutil.copy2(s,q)
def main():
 p=argparse.ArgumentParser(); p.add_argument('--input',required=True,type=Path); p.add_argument('--output',required=True,type=Path); p.add_argument('--install-profile'); x=p.parse_args(); d=json.loads(x.input.read_text()); render(d,x.output)
 if x.install_profile:
  if x.install_profile!=d['profile']['name']: bad('--install-profile must match profile.name')
  install(x.output,x.install_profile)
 print(x.output)
if __name__=='__main__':
 try: main()
 except (ValueError,json.JSONDecodeError,subprocess.CalledProcessError) as e: print('ERROR:',e,file=sys.stderr); raise SystemExit(2)
