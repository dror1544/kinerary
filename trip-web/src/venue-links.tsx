import { External, tr, type Lang } from './parity-ui';

export function VenueLinks({ venue, lang, ticketsLabel }: { venue: { maps?: string; waze?: string; tickets?: string; url?: string }; lang: Lang; ticketsLabel?: string }) {
  return <>
    <External url={venue.maps}>{tr(lang, 'Maps', 'מפה')}</External>
    <External url={venue.waze}>Waze</External>
    <External url={venue.tickets || venue.url}>{ticketsLabel || tr(lang, 'Tickets', 'כרטיסים')}</External>
  </>;
}
