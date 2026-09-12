import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Send, MessageCircle, Copy } from 'lucide-react';
import { api } from './api';
import { CompanionTasks } from './CompanionTasks';

type Message = { id: string; author: string; text: string; kind: 'question' | 'reply' | 'group_update'; reply_to: string | null; created_at: string; answered?: number };
type Conversation = { inbox_active: boolean; connection: { group_url: string | null; bot_username: string | null } | null; latest_update: Message | null; messages: Message[] };
export function CompanionPanel({ name, lang, isOrganizer, telegramUsername }: { name: string; lang: 'he' | 'en'; isOrganizer?: boolean; telegramUsername?: string | null }) {
  const copy = (en: string, he: string) => lang === 'he' ? he : en;
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const conversation = useQuery({ queryKey: ['companion-conversation'], queryFn: () => api<Conversation>('/api/companion/conversation'), refetchInterval: 15_000 });
  const connection = useQuery({ queryKey: ['companion-connection'], queryFn: () => api<{ binding_command: string | null }>('/api/companion/connection'), enabled: !!isOrganizer, refetchInterval: 30_000 });
  const send = useMutation({
    mutationFn: (text: string) => api('/api/companion/conversation', { method: 'POST', body: JSON.stringify({ text }) }),
    onSuccess: () => { setDraft(''); setNotice(copy('Saved. Waiting for the companion to reply.', 'נשמר. ממתינים לתשובת העוזר.')); void client.invalidateQueries({ queryKey: ['companion-conversation'] }); },
  });
  const username = conversation.data?.connection?.bot_username || telegramUsername;
  const privateUrl = username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? `https://t.me/${username}` : null;
  const groupUrl = conversation.data?.connection?.group_url;
  const stamp = (value: string) => new Date(value).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const copyCommand = async () => {
    try {
      // Fetch again so a command that expired while the page was open is not copied.
      const current = await api<{ binding_command: string | null }>('/api/companion/connection');
      if (!current.binding_command) { setNotice(copy('No active connection command. Ask the companion privately for a new one.', 'אין פקודת חיבור פעילה. בקשו מהעוזר בפרטי פקודה חדשה.')); return; }
      await navigator.clipboard.writeText(current.binding_command);
      setNotice(copy('Copied. Paste it into the trip’s Telegram group.', 'הועתק. הדביקו בקבוצת הטלגרם של הטיול.'));
    } catch { setNotice(copy('Could not copy the command. Try again.', 'לא ניתן להעתיק את הפקודה. נסו שוב.')); }
  };
  return <section className="companion-panel" aria-label={name}>
    <div className="companion-head"><div><span className="panel-label"><Bot size={18} />{name}</span><h3>{copy('Your trip conversation', 'השיחה של הטיול')}</h3></div></div>
    {isOrganizer && <CompanionTasks lang={lang} />}
    <p>{copy('Ask a question or suggest a change. Messages and replies here are shared with everyone on this trip.', 'שאלו שאלה או הציעו שינוי. ההודעות והתשובות כאן משותפות לכל משתתפי הטיול.')}</p>
    {conversation.isPending && <p>{copy('Loading messages…', 'טוענים הודעות…')}</p>}
    {conversation.isError && <p role="alert">{copy('Could not load messages.', 'לא ניתן לטעון הודעות.')} <button type="button" onClick={() => conversation.refetch()}>{copy('Try again', 'ניסיון נוסף')}</button></p>}
    {conversation.data && <>
      {!conversation.data.inbox_active && <p role="status">{copy('The companion is not checking website messages right now. You can leave a question for when it returns.', 'העוזר אינו בודק כרגע הודעות באתר. אפשר להשאיר שאלה לזמן שבו יחזור.')}</p>}
      <div className="companion-latest"><strong>{copy('Latest group update', 'העדכון האחרון לקבוצה')}</strong>
        {conversation.data.latest_update ? <><p>{conversation.data.latest_update.text}</p><time dateTime={conversation.data.latest_update.created_at}>{stamp(conversation.data.latest_update.created_at)}</time></> : <p>{copy('No group update has been shared here yet.', 'עדיין לא שותף כאן עדכון מהקבוצה.')}</p>}
      </div>
      <div className="companion-messages" aria-label={copy('Trip messages', 'הודעות הטיול')}>
        {conversation.data.messages.length === 0 && <p>{copy('Have an idea for the day? Start the conversation.', 'יש לכם רעיון להיום? התחילו את השיחה.')}</p>}
        {conversation.data.messages.map(message => {
          const question = message.reply_to ? conversation.data!.messages.find(row => row.id === message.reply_to) : null;
          return <article key={message.id} className={`companion-message ${message.kind}`}><strong>{message.kind === 'reply' ? name : message.author}</strong><time dateTime={message.created_at}>{stamp(message.created_at)}</time>
            {question && <blockquote>{question.text}</blockquote>}<p>{message.text}</p>
            {message.kind === 'question' && !message.answered && <small>{copy('Waiting for the companion', 'ממתינים לעוזר')}</small>}
          </article>;
        })}
      </div>
    </>}
    <form onSubmit={event => { event.preventDefault(); if (draft.trim() && !send.isPending) { setNotice(''); send.mutate(draft.trim()); } }}>
      <label className="bot-input"><span>{copy('Question or suggestion', 'שאלה או הצעה')}</span><textarea maxLength={2000} value={draft} disabled={send.isPending} onChange={event => setDraft(event.target.value)} placeholder={copy('What would make today better?', 'מה יכול לשפר את היום שלכם?')} /></label>
      <div className="bot-actions"><button className="primary-action" disabled={!draft.trim() || send.isPending || !conversation.data} type="submit"><Send size={17} />{send.isPending ? copy('Saving…', 'שומרים…') : copy('Send to companion', 'שליחה לעוזר')}</button>
        {groupUrl && <a className="secondary-action" href={groupUrl} target="_blank" rel="noreferrer"><MessageCircle size={17} />{copy('Open Telegram group', 'פתיחת קבוצת הטלגרם')}</a>}
        {isOrganizer && privateUrl && <a className="secondary-action" href={privateUrl} target="_blank" rel="noreferrer"><MessageCircle size={17} />{copy('Private companion chat', 'שיחה פרטית עם העוזר')}</a>}
        {isOrganizer && connection.data?.binding_command && <button type="button" className="secondary-action" onClick={copyCommand}><Copy size={17} />{copy('Copy group connection command', 'העתקת פקודת החיבור לקבוצה')}</button>}
      </div>
    </form>
    {send.isError && <p role="alert">{copy('Message was not saved. Try again; if you already have five unanswered messages, wait for a reply.', 'ההודעה לא נשמרה. נסו שוב; אם כבר יש חמש הודעות ללא מענה, המתינו לתשובה.')}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
