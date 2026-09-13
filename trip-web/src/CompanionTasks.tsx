import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2, Play, Clock3 } from 'lucide-react';
import { api } from './api';

type Task = { id: string; label: { he: string; en: string }; audience: 'website' | 'group' | 'private'; enabled: boolean; schedule: string; timezone: string; next_run: string | null };
type State = { available: boolean; scheduler_running: boolean; tasks: Task[] };
export function CompanionTasks({ lang }: { lang: 'he' | 'en' }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const copy = (en: string, he: string) => lang === 'he' ? he : en;
  const tasks = useQuery({ queryKey: ['companion-tasks'], queryFn: () => api<State>('/api/companion/tasks'), enabled: open, refetchInterval: open ? 30_000 : false });
  const change = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'run' }) => api<State>(`/api/companion/tasks/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action }) }),
    onMutate: async () => { setNotice(''); await client.cancelQueries({ queryKey: ['companion-tasks'] }); },
    onSuccess: (state, input) => {
      client.setQueryData(['companion-tasks'], state);
      if (input.action === 'run') setNotice(copy('Queued for the next scheduler check.', 'נוסף להפעלה בבדיקה הקרובה.'));
    },
  });
  const nextRun = (task: Task) => {
    if (!task.next_run || !Number.isFinite(Date.parse(task.next_run))) return copy('Not scheduled', 'לא נקבע מועד');
    try { return new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: task.timezone }).format(new Date(task.next_run)); }
    catch { return new Date(task.next_run).toISOString(); }
  };
  const scheduleLabel = (schedule: string) => {
    const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule);
    if (daily) return copy(`Daily at ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}`, `כל יום ב־${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}`);
    const interval = /^every (\d+)m$/.exec(schedule);
    if (interval) return copy(`Every ${interval[1]} minutes`, `כל ${interval[1]} דקות`);
    return copy('Custom schedule', 'תזמון מותאם');
  };
  const audience = (value: Task['audience']) => value === 'website' ? copy('Website', 'אתר הטיול') : value === 'group' ? copy('Telegram group', 'קבוצת הטלגרם') : copy('Organizer privately', 'למארגן בפרטי');
  return <div className="companion-settings">
    <button type="button" className="secondary-action companion-settings-toggle" aria-label={copy('Companion settings', 'הגדרות העוזר')} title={copy('Companion settings', 'הגדרות העוזר')} aria-expanded={open} onClick={() => setOpen(!open)}><Settings2 size={18} aria-hidden="true" /></button>
    {open && <section aria-label={copy('Scheduled updates', 'עדכונים מתוזמנים')}>
      <h4>{copy('Scheduled updates', 'עדכונים מתוזמנים')}</h4>
      {tasks.isPending && <p>{copy('Loading scheduled updates…', 'טוענים עדכונים מתוזמנים…')}</p>}
      {tasks.isError && <p role="alert">{copy('Could not load updates.', 'לא ניתן לטעון את העדכונים.')} <button type="button" onClick={() => tasks.refetch()}>{copy('Try again', 'ניסיון נוסף')}</button></p>}
      {tasks.data && !tasks.data.available && <p>{copy('Scheduled updates are not connected for this trip yet.', 'העדכונים המתוזמנים עדיין לא מחוברים לטיול הזה.')}</p>}
      {tasks.data?.available && <>
        {!tasks.data.scheduler_running && <p role="status">{copy('The scheduler is not responding. Updates may be delayed.', 'המתזמן אינו מגיב. העדכונים עשויים להתעכב.')}</p>}
        {!tasks.data.tasks.length && <p>{copy('No scheduled trip updates yet.', 'עדיין אין עדכונים מתוזמנים לטיול.')}</p>}
        {tasks.data.tasks.map(task => <article key={task.id} className="companion-task">
          <div className="companion-task-heading"><strong>{task.label[lang] || task.label.en}</strong>
            <button type="button" role="switch" aria-label={task.label[lang] || task.label.en} aria-checked={task.enabled} disabled={change.isPending} onClick={() => change.mutate({ id: task.id, action: task.enabled ? 'pause' : 'resume' })}>{task.enabled ? copy('On', 'פעיל') : copy('Paused', 'מושהה')}</button>
          </div>
          <small>{audience(task.audience)} · {scheduleLabel(task.schedule)}</small>
          <p><Clock3 size={14} /> {task.enabled ? nextRun(task) : copy('Paused', 'מושהה')} · {task.timezone}</p>
          <button type="button" className="secondary-action" disabled={!task.enabled || !tasks.data?.scheduler_running || change.isPending} onClick={() => change.mutate({ id: task.id, action: 'run' })}><Play size={14} />{copy('Run now', 'הפעלה עכשיו')}</button>
        </article>)}
      </>}
      {change.isError && <p role="alert">{copy('The change was not confirmed. Refresh to check the current setting.', 'השינוי לא אושר. רעננו כדי לבדוק את ההגדרה הנוכחית.')} <button type="button" onClick={() => tasks.refetch()}>{copy('Refresh', 'רענון')}</button></p>}
      {notice && <p role="status">{notice}</p>}
    </section>}
  </div>;
}
