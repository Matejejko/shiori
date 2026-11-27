// Folders and content types are MangaPin's numbers (folder names can be changed in Settings →
// Labels, synced). Tags are names: whatever the site calls the genre, cleaned up (normalizeTag).
// MANGAPIN_TAGS is MangaPin's tag table (my.mangapin.com/assets/assets/scripts/tags.json, fetched
// 2026-11-23): it turns the numbers of a MangaPin import into names, and gives the spellings that
// count as the same tag. tools/shiori-to-mangapin.html carries a copy to turn names back.
import { withField } from './mangapin.js';

export const DEFAULT_LABELS = {
  folder: { 1: 'Reading', 2: 'Hiatus', 3: 'Planned', 4: 'Completed', 5: 'Dropped' },
  type: { 1: 'Comic', 2: 'Novel', 3: 'Anime' }, // MangaPin content types; no type = comic
};

export const MANGAPIN_TAGS = { 1: "Manga", 2: "Manhua", 3: "Manhwa", 4: "Comic", 5: "Novel", 6: "Anime", 7: "Donghua", 11: "Shounen", 12: "Shoujo", 13: "Seinen", 14: "Josei", 15: "Yaoi", 16: "Yuri", 20: "4 Koma", 21: "Adaptation", 22: "Anthology", 23: "Award Winning", 24: "Doujinshi", 25: "Fan Colored", 26: "Full Color", 27: "Long Strip", 28: "Official Colored", 29: "Oneshot", 30: "Self Published", 31: "Web Comic", 40: "Adult", 41: "Bloody", 42: "Ecchi", 43: "Erotica", 44: "Gore", 45: "Hentai", 46: "Mature", 47: "Smut", 49: "Violence", 60: "Action", 61: "Adventure", 62: "Age Gap", 63: "Aliens", 64: "Animals", 65: "Beasts", 66: "Bodyswap", 67: "Boys' Love", 68: "Cheating", 69: "Childhood Friends", 70: "Comedy", 71: "Cooking", 72: "Crime", 73: "Cross Dressing", 74: "Crossdressing", 75: "Cultivation", 76: "Delinquents", 77: "Demons", 78: "Detective", 79: "Drama", 80: "Dungeons", 81: "Fantasy", 82: "Fetish", 83: "Food", 84: "Game", 85: "Genderswap", 86: "Ghosts", 87: "Girls' Love", 88: "Gyaru", 89: "Harem", 90: "Historical", 91: "Horror", 92: "Incest", 93: "Isekai", 94: "Loli", 95: "Mafia", 96: "Magic", 97: "Magical Girls", 98: "Martial Arts", 99: "Mecha", 100: "Medical", 101: "Military", 102: "Modern Setting", 103: "Monster Girls", 104: "Monsters", 105: "Murim", 106: "Music", 107: "Mystery", 108: "Ninja", 109: "Office Workers", 110: "Overpowered", 111: "Parody", 112: "Philosophical", 113: "Police", 114: "Post Apocalyptic", 115: "Psychological", 116: "Reincarnation", 117: "Revenge", 118: "Reverse Harem", 119: "Romance", 120: "Royalty", 121: "Samurai", 122: "School Life", 123: "Sci Fi", 124: "Science Fiction", 125: "Shota", 126: "Slice of Life", 127: "Sports", 128: "Superhero", 129: "Supernatural", 130: "Survival", 131: "System", 132: "Thriller", 133: "Time Travel", 134: "Traditional Games", 135: "Tragedy", 136: "Transmigration", 137: "Vampires", 138: "Video Games", 139: "Villain", 140: "Villainess", 141: "Virtual Reality", 142: "Webtoon", 143: "Wuxia", 144: "Yakuzas", 145: "Zombies" };

// Other spellings of a tag (other languages, misspellings) — by MangaPin id. Only true variants:
// MangaPin also folded related genres together (regression → Reincarnation, love → Romance);
// Shiori keeps those as their own tags.
const VARIANTS = { 11: ["shônen"], 15: ["shounen ai"], 16: ["shoujo ai"], 40: ["adulte", "Yetişkin"], 45: ["pornographic"], 60: ["aksiyon", "acción"], 61: ["aventure", "macera", "aventura"], 63: ["uzaylı"], 67: ["shounen ai"], 68: ["infideli"], 69: ["niños"], 70: ["funny", "comédie", "komedi", "comedia"], 72: ["crimen"], 77: ["démons", "demonios", "Şeytan"], 78: ["polisiye"], 79: ["drame", "dram"], 81: ["fantastique", "fantaisie", "fantastik", "fantasia"], 85: ["género bender"], 86: ["hayalet"], 90: ["historique", "historia"], 91: ["horreur"], 94: ["lolicon"], 96: ["magie", "magia"], 97: ["mahou shoujo", "sihirli kız"], 98: ["martial", "art martiaux", "dövüş sanatları", "artes marciales"], 101: ["militaire", "militar"], 104: ["monstres"], 106: ["musica"], 107: ["mystère", "misterio", "gizem"], 111: ["parodia", "parodi"], 113: ["policiaco"], 114: ["apocalypse", "apocalíptico"], 115: ["psychologie", "psicológico", "psikoloji"], 116: ["regression", "rebirth", "reincarnate", "return", "returned", "returner", "réincarnation", "reenkarnasyon", "reencarnación"], 117: ["vengeance"], 119: ["love", "romantizm"], 121: ["samurái"], 122: ["vie scolaire", "vida escolar"], 124: ["ciencia ficción", "bilim kurgu"], 126: ["tranches de vie", "recuentos de la vida", "yaşamdan kesitler"], 127: ["deporte", "spor"], 128: ["süper kahramanlar"], 129: ["surnaturel", "sobrenatural", "doğaüstü", "süper güçler"], 130: ["hayatta Kalma", "supervivencia"], 131: ["cheat system"], 133: ["zaman Yolculuğu"], 135: ["tragédie", "trajedi", "tragedia"], 137: ["vampiros", "vampir"], 140: ["villianes"], 141: ["realidad virtual"], 145: ["zombi"] };
const NOT_VARIANTS = new Set(['regression', 'rebirth', 'reincarnate', 'return', 'returned', 'returner', 'love', 'funny', 'cheat system', 'pornographic', 'apocalypse', 'shounen ai', 'shoujo ai', 'niños', 'süper güçler']);

/** Comparison key: case, accents, spaces and punctuation don't make a different tag. */
export const tagKey = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

let canon = null;
function canonical() {
  if (canon) return canon;
  canon = new Map();
  for (const n of Object.values(MANGAPIN_TAGS)) if (!canon.has(tagKey(n))) canon.set(tagKey(n), n); // "Cross Dressing" = "Crossdressing"
  for (const [id, list] of Object.entries(VARIANTS)) {
    for (const a of list) if (!NOT_VARIANTS.has(a.toLowerCase())) canon.set(tagKey(a), MANGAPIN_TAGS[id]);
  }
  canon.set(tagKey('Sci-Fi'), 'Science Fiction');
  return canon;
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const titleCase = (t) => t.toLowerCase().replace(/[\p{L}\p{N}][^\s-]*/gu, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));

/** One tag in its stored form, or null. Numbers are MangaPin ids. */
export function normalizeTag(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? MANGAPIN_TAGS[v] || `Tag ${v}` : null;
  let t = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  if (!/\p{L}/u.test(t)) return null;
  const known = canonical().get(tagKey(t));
  if (known) return known;
  if (t === t.toLowerCase() || t === t.toUpperCase()) t = titleCase(t);
  return t;
}

/** A tag list in stored form: normalized, first spelling of each tag kept, order kept. */
export function normalizeTags(list) {
  const out = [], seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const t = normalizeTag(v);
    if (t && !seen.has(tagKey(t))) { seen.add(tagKey(t)); out.push(t); }
  }
  return out;
}

/** The entry with its tags in stored form (the same object when they already are). */
export function normalizeEntry(e) {
  if (!e || !Array.isArray(e.tags)) return e;
  const t = normalizeTags(e.tags);
  return t.length === e.tags.length && t.every((x, i) => x === e.tags[i]) ? e : withField(e, 'tags', t);
}
