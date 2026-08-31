#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,re,shutil,subprocess,sys
from pathlib import Path
from string import Template
ROOT=Path(__file__).resolve().parent
SECRET_KEY=re.compile(r'(?:^|_)(?:token|password|secret|api_?key|bot_?token|credential)(?:$|_)',re.I)
def bad(m): raise ValueError(m)
SAFE_KEYS={'secret_redaction'}
def scan(v,p='$'):
 if isinstance(v,dict):
  for k,x in v.items():
   if SECRET_KEY.search(str(k)) and str(k) not in SAFE_KEYS: bad(f'secret-like key is forbidden: {p}.{k}')
   scan(x,f'{p}.{k}')
 elif isinstance(v,list):
  for i,x in enumerate(v): scan(x,f'{p}[{i}]')
def validate(d):
 req={'schema_version','record_type','profile','interviewer','backend','messaging','notifications','privacy'}
 if set(d)!=req: bad(f'top-level contract mismatch: missing={sorted(req-set(d))}, extra={sorted(set(d)-req)}')
 scan(d)
 if d['schema_version']!=1 or d['record_type']!='hermes_interviewer_profile_input': bad('unsupported setup contract')
 shapes={
  'profile':({'name','description'},{'name','description'}),
  'interviewer':({'display_name','service_name','subject_label','default_language','supported_languages'},{'display_name','service_name','subject_label','default_language','supported_languages'}),
  'backend':({'connection_name','url','auth_mode','enrollment_required'},{'connection_name','url','auth_mode','enrollment_required'}),
  'messaging':({'platform','private_only','allow_group_chats','authorization_mode'},{'platform','private_only','allow_group_chats','authorization_mode'}),
  'notifications':({'mode'},{'mode','event_directory'}),
  'privacy':({'pii_redaction','secret_redaction','sensitive_default','retention'},{'pii_redaction','secret_redaction','sensitive_default','retention'})}
 for sec,(required,allowed) in shapes.items():
  actual=set(d.get(sec,{})); missing=required-actual; extra=actual-allowed
  if missing or extra: bad(f'{sec} contract mismatch: missing={sorted(missing)}, extra={sorted(extra)}')
 if not re.fullmatch(r'[a-z][a-z0-9]{2,31}',d['profile'].get('name','')): bad('invalid profile name')
 if d['interviewer'].get('default_language') not in d['interviewer'].get('supported_languages',[]): bad('default language must be supported')
 if d['backend'].get('auth_mode') not in {'header','oauth','none'}: bad('unsupported backend auth mode')
 if d['notifications'].get('mode') not in {'event_files','disabled'}: bad('unsupported notification mode')
 if d['backend'].get('enrollment_required') is not True: bad('enrollment verification must be required')
 m=d['messaging']
 if m.get('private_only') is not True or m.get('allow_group_chats') is not False or m.get('authorization_mode')!='enrollment_token': bad('interviewer messaging must be private and enrollment-authorized')
 q=d['privacy']
 if q.get('pii_redaction') is not True or q.get('secret_redaction') is not True or q.get('sensitive_default')!='private': bad('privacy defaults are not fail-closed')
 if not re.match(r'^https?://',d['backend'].get('url','')): bad('backend URL must use HTTP(S)')
def tpl(path,v): return Template(path.read_text()).substitute(v)
def render(d,out):
 validate(d)
 if out.exists() and any(out.iterdir()): bad(f'output is not empty: {out}')
 out.mkdir(parents=True,exist_ok=True); i=d['interviewer']; b=d['backend']; n=d['notifications']
 policy='Notifications are disabled.' if n['mode']=='disabled' else 'Write only minimal started, issue, and completed JSON events to the configured notification directory. A deterministic external notifier delivers them; never claim you sent them yourself.'
 v={'PROFILE_NAME':d['profile']['name'],'PROFILE_DESCRIPTION_JSON':json.dumps(d['profile']['description'],ensure_ascii=False),'INTERVIEWER_NAME':i['display_name'],'SERVICE_NAME':i['service_name'],'SUBJECT_LABEL':i['subject_label'],'DEFAULT_LANGUAGE':i['default_language'],'SUPPORTED_LANGUAGES':', '.join(i['supported_languages']),'CONNECTION_NAME':b['connection_name'],'BACKEND_URL':b['url'],'NOTIFICATION_POLICY':policy}
 for src,dst in [('SOUL.md.tpl','profile/SOUL.md'),('profile.yaml.tpl','profile/profile.yaml'),('config.overlay.yaml.tpl','profile/config.overlay.yaml'),('workspace/.hermes.md.tpl','workspace/.hermes.md'),('workspace/references/sources.md.tpl','workspace/references/sources.md')]:
  p=out/dst; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(tpl(ROOT/'templates'/src,v))
 shutil.copytree(ROOT/'templates/skills',out/'profile/skills'); (out/'workspace/notes-rw/notifications').mkdir(parents=True,exist_ok=True)
 lines=['# Installation','','This bundle contains no secrets. Create a fresh profile, copy `profile/`, and set its workspace. Configure model, interview service, and gateway through Hermes CLI.','','```bash',f"hermes profile create {d['profile']['name']} --no-skills --description {json.dumps(d['profile']['description'])}",f"hermes -p {d['profile']['name']} config set terminal.cwd /absolute/path/to/workspace",f"hermes -p {d['profile']['name']} config set security.redact_secrets true",f"hermes -p {d['profile']['name']} config set privacy.redact_pii true",f"hermes -p {d['profile']['name']} config set approvals.mode smart",f"hermes -p {d['profile']['name']} mcp add {b['connection_name']} --url {b['url']} --auth {b['auth_mode']}",f"hermes -p {d['profile']['name']} mcp test {b['connection_name']}",f"hermes -p {d['profile']['name']} gateway setup",f"hermes -p {d['profile']['name']} gateway start",f"hermes -p {d['profile']['name']} gateway status",'```','','Before invitations, verify only four interview tools, a unique bot token, restricted allowlist, disabled group chats, and no provisioning/existing-subject access.']
 (out/'INSTALL.md').write_text('\n'.join(lines)+'\n')
def install(bundle,name,workspace):
 home=Path.home()/'.hermes/profiles'/name
 if home.exists(): bad(f'refusing to overwrite existing profile: {home}')
 if workspace.exists() and any(workspace.iterdir()): bad(f'refusing non-empty workspace: {workspace}')
 subprocess.run(['hermes','profile','create',name,'--no-skills','--description',f'Private intake interviewer {name}'],check=True)
 for p in (bundle/'profile').iterdir():
  q=home/p.name
  shutil.copytree(p,q,dirs_exist_ok=True) if p.is_dir() else shutil.copy2(p,q)
 shutil.copytree(bundle/'workspace',workspace,dirs_exist_ok=True)
 for key,val in [('terminal.cwd',str(workspace)),('security.redact_secrets','true'),('privacy.redact_pii','true'),('approvals.mode','smart')]: subprocess.run(['hermes','-p',name,'config','set',key,val],check=True)
def main():
 p=argparse.ArgumentParser(); p.add_argument('--input',required=True,type=Path); p.add_argument('--output',required=True,type=Path); p.add_argument('--install-profile'); p.add_argument('--workspace',type=Path); a=p.parse_args(); d=json.loads(a.input.read_text()); render(d,a.output)
 if a.install_profile:
  if a.install_profile!=d['profile']['name']: bad('--install-profile must match profile.name')
  if not a.workspace or not a.workspace.is_absolute(): bad('--workspace must be an absolute path for installation')
  install(a.output,a.install_profile,a.workspace)
 print(a.output)
if __name__=='__main__':
 try: main()
 except (ValueError,json.JSONDecodeError,subprocess.CalledProcessError) as e: print('ERROR:',e,file=sys.stderr); raise SystemExit(2)
