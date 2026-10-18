"""trip-kml-export: the script a companion runs to hand a family a map file.

Review 2026-10-11: run against a served /api/config the script crashed —
`TypeError: write() argument must be str, not dict` — because a config-built
trip names things bilingually (`{"he": ..., "en": ...}`), and the description
printed the stop's title as a Python dict. The owner's rule for the fix:
"KML needs to be fixed. Avoid English on KML if possible."

What these tests pin:
  - every name/description is ONE string in the trip's own language
    (meta.defaultLang; else Hebrew when the config carries any Hebrew; else
    English), falling back to the other language only when the preferred one
    is missing or empty — never both side by side;
  - legacy plain strings, missing keys and None all work;
  - the output parses as XML, with Hebrew intact and markup characters escaped;
  - a served config (title objects, mapStop pins, hotels[]) yields placemarks.

All trip data here is fictional.
"""
import importlib.util, json, re, subprocess, sys, tempfile, unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'templates/skills/travel/trip-kml-export/scripts/trip_kml_export.py'
NS = {'k': 'http://www.opengis.net/kml/2.2'}
HEBREW = re.compile('[֐-׿]')


def load():
    spec = importlib.util.spec_from_file_location('trip_kml_export', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(config, bookings=None, mode='all'):
    """Run the script exactly as the skill does: JSON on stdin, file out."""
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / 'trip.kml'
        payload = json.dumps({'config': config, 'bookings': bookings or []}, ensure_ascii=False)
        cp = subprocess.run([sys.executable, str(SCRIPT), '--filter', mode, '--output', str(out)],
                            input=payload, text=True, capture_output=True)
        raw = out.read_bytes() if out.exists() else b''
    return cp, raw


def colmar(lang='he'):
    """The Colmar-shaped config a 2026-10-10 manual run produced, as /api/config serves it."""
    return {
        'meta': {'title': {'he': 'אלזס 2026', 'en': 'Alsace 2026'}, 'defaultLang': lang},
        'phases': [
            {'id': 'frankfurt', 'title': {'he': 'פרנקפורט', 'en': 'Frankfurt'},
             'dates': {'start': '2026-12-02', 'end': '2026-12-03'},
             'mapStop': {'lat': 50.11, 'lng': 8.68, 'name': {'he': 'פרנקפורט', 'en': 'Frankfurt'}}},
            {'id': 'colmar', 'title': {'he': 'קולמר', 'en': 'Colmar'},
             'dates': {'start': '2026-12-03', 'end': '2026-12-06'},
             'accommodation': {'name': {'he': 'מלון הגשר', 'en': 'Bridge Hotel'},
                               'address': '1 Rue Exemple', 'confirmation': 'ABC123',
                               'notes': [{'style': 'info', 'text': {'he': 'חניה בחצר', 'en': 'Parking in the yard'}}],
                               'lat': 48.08, 'lng': 7.36}},
            {'id': 'open-days', 'unplanned': True,
             'title': {'he': 'ימים שעוד לא תוכננו', 'en': 'Days not planned yet'}},
        ],
    }


def texts(raw):
    root = ET.fromstring(raw)
    names = [e.text or '' for e in root.iter('{%s}name' % NS['k'])]
    descs = [e.text or '' for e in root.iter('{%s}description' % NS['k'])]
    return root, names, descs


class Resolve(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_prefers_the_trip_language_and_falls_back_only_when_empty(self):
        t = self.m.text_in
        self.assertEqual(t({'he': 'קולמר', 'en': 'Colmar'}, 'he'), 'קולמר')
        self.assertEqual(t({'he': 'קולמר', 'en': 'Colmar'}, 'en'), 'Colmar')
        self.assertEqual(t({'en': 'Colmar'}, 'he'), 'Colmar')
        self.assertEqual(t({'he': '', 'en': 'Colmar'}, 'he'), 'Colmar')
        self.assertEqual(t({'he': '  ', 'en': None}, 'he'), '')
        self.assertEqual(t('legacy name', 'he'), 'legacy name')
        self.assertEqual(t(None, 'he'), '')
        self.assertEqual(t(42, 'he'), '42')
        self.assertEqual(t({}, 'he'), '')

    def test_trip_language(self):
        lang = self.m.trip_language
        self.assertEqual(lang({'meta': {'defaultLang': 'en'}, 'phases': [{'title': {'he': 'א'}}]}), 'en')
        self.assertEqual(lang({'meta': {'defaultLang': 'he'}}), 'he')
        self.assertEqual(lang({'phases': [{'title': {'he': 'קולמר', 'en': 'Colmar'}}]}), 'he')
        self.assertEqual(lang({'phases': [{'title': 'Colmar'}]}), 'en')
        self.assertEqual(lang({}), 'en')
        self.assertEqual(lang({'meta': None}), 'en')


class Export(unittest.TestCase):
    def test_bilingual_hebrew_trip_is_valid_kml_with_no_english_alongside(self):
        cp, raw = run(colmar('he'))
        self.assertEqual(cp.returncode, 0, cp.stderr)
        root, names, descs = texts(raw)
        body = raw.decode('utf-8')
        self.assertIn('מלון הגשר', names)
        self.assertTrue(any('קולמר' in d for d in descs), descs)
        self.assertTrue(any('חניה בחצר' in d for d in descs), descs)
        for english in ('Bridge Hotel', 'Colmar', 'Frankfurt', 'Alsace', 'Parking',
                        'address:', 'notes:', 'confirmation', "{'he'", '{"he"'):
            self.assertNotIn(english, body, f'English or a dict leaked into a Hebrew trip: {english!r}')
        meta = json.loads(cp.stdout)
        self.assertEqual(meta['trip'], 'אלזס 2026')
        # One hotel: Frankfurt has a pin but no hotel, and a stop is not a hotel.
        self.assertEqual(meta['placemarks'], 1)

    def test_english_default_trip_writes_english_only(self):
        cp, raw = run(colmar('en'))
        self.assertEqual(cp.returncode, 0, cp.stderr)
        _, names, descs = texts(raw)
        self.assertIn('Bridge Hotel', names)
        body = raw.decode('utf-8')
        self.assertNotIn('מלון הגשר', body)
        self.assertNotIn('קולמר', body)
        self.assertIsNone(HEBREW.search(body), 'a Hebrew label leaked into an English trip')

    def test_missing_hebrew_falls_back_to_the_other_language(self):
        cfg = colmar('he')
        cfg['phases'][1]['accommodation']['name'] = {'en': 'Bridge Hotel'}
        cp, raw = run(cfg)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        _, names, _ = texts(raw)
        self.assertIn('Bridge Hotel', names)

    def test_legacy_string_config(self):
        cfg = {'tripName': 'טיול משפחתי', 'phases': [
            {'name': 'רומא', 'startDate': '2026-05-01', 'endDate': '2026-05-04',
             'accommodation': {'name': 'מלון רומא', 'lat': '41.9', 'lon': '12.5', 'checkIn': '15:00'}}]}
        cp, raw = run(cfg)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        _, names, descs = texts(raw)
        self.assertIn('מלון רומא', names)
        self.assertTrue(any('רומא' in d and '2026-05-01' in d for d in descs), descs)

    def test_markup_characters_are_escaped_and_round_trip(self):
        cfg = colmar('he')
        nasty = 'מלון "הכוכב" & <בר> \'שלי\'\nשורה 2'
        cfg['meta']['title'] = {'he': 'טיול "א" & <ב>'}
        cfg['phases'][1]['accommodation']['name'] = {'he': nasty}
        cfg['phases'][1]['title'] = {'he': 'קולמר & <שוק>'}
        cp, raw = run(cfg)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        root, names, descs = texts(raw)        # ET.fromstring raises on invalid XML
        self.assertIn(nasty, names)
        self.assertTrue(any('קולמר & <שוק>' in d for d in descs))
        self.assertIn('טיול "א" & <ב>', names[0])
        self.assertNotIn(b'<\xd7\x91\xd7\xa8>', raw, 'a raw < reached the file')
        self.assertTrue(raw.startswith(b"<?xml version='1.0' encoding='utf-8'?>") or raw.startswith(b'<?xml'))

    def test_control_characters_do_not_break_the_file(self):
        cfg = colmar('he')
        cfg['phases'][1]['accommodation']['name'] = {'he': 'מלון\x00\x07 בדיקה'}
        cp, raw = run(cfg)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        _, names, _ = texts(raw)
        self.assertIn('מלון בדיקה', names)

    def test_empty_and_missing_phases(self):
        for cfg in ({'meta': {'defaultLang': 'he'}, 'phases': []}, {}, {'phases': None},
                    {'phases': [None, {}, {'accommodation': None}, {'title': None, 'hotels': None}]}):
            cp, raw = run(cfg)
            self.assertEqual(cp.returncode, 0, (cfg, cp.stderr))
            texts(raw)
            self.assertEqual(json.loads(cp.stdout)['placemarks'], 0)

    def test_served_shape_pins_come_from_hotels_and_the_stop_pin(self):
        # /api/config carries no lat/lng on `accommodation`; the coordinates it
        # does serve are phases[].hotels[] and phases[].mapStop.
        cfg = colmar('he')
        del cfg['phases'][1]['accommodation']['lat'], cfg['phases'][1]['accommodation']['lng']
        cfg['phases'][1]['mapStop'] = {'lat': 48.08, 'lng': 7.36, 'name': {'he': 'קולמר'}}
        cfg['phases'][0]['hotels'] = [{'name': {'he': 'מלון התחנה', 'en': 'Station Hotel'}, 'lat': 50.1, 'lng': 8.6}]
        cp, raw = run(cfg, mode='hotels')
        self.assertEqual(cp.returncode, 0, cp.stderr)
        root, names, _ = texts(raw)
        self.assertIn('מלון התחנה', names)
        self.assertIn('מלון הגשר', names)
        coords = [e.text for e in root.iter('{%s}coordinates' % NS['k'])]
        self.assertIn('7.36,48.08,0', coords)

    def test_bilingual_bookings(self):
        bookings = [{'type': 'attraction', 'name': {'he': 'מוזיאון', 'en': 'Museum'},
                     'notes': 'כרטיסים בקופה', 'date_from': '2026-12-04', 'lat': 48.07, 'lng': 7.35}]
        cp, raw = run(colmar('he'), bookings, mode='attractions')
        self.assertEqual(cp.returncode, 0, cp.stderr)
        _, names, descs = texts(raw)
        self.assertIn('מוזיאון', names)
        visible = '\n'.join(names + descs)    # style ids like "#attraction" are markup, not text
        self.assertTrue(any('כרטיסים בקופה' in d and '2026-12-04' in d for d in descs), descs)
        for english in ('Museum', 'attraction', 'notes:', 'date:'):
            self.assertNotIn(english, visible, english)


if __name__ == '__main__':
    unittest.main()
