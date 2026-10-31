import "server-only";
import crypto from "node:crypto";
import { sql, type Insertable, type Transaction } from "kysely";
import { encryptWith, getAppSecret } from "../crypto";
import { simAudience, simHash, simMetrics } from "../platforms/simulated";
import { aggregatePostStatus, buildUtmUrl, localDay, normalizePostContent, zonedTimeToUtc } from "@/social/normalize";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import type { Platform, QueueSlot, TargetStatus } from "@/social/types";
import type { Database } from "./schema";

/**
 * Social demo data (DEMO_SEED): an agency workspace with two clients, a creator workspace, three
 * small customer workspaces, 90 days of publishing history with metrics, a full calendar for the
 * next two weeks, approvals, automation (RSS, recycling), short links and notifications.
 *
 * Everything is built in memory with explicit ids and written with multi-row inserts, so it fits
 * one request on a remote database (about 7,000 rows). Channels are compatible with the
 * simulated drivers of DEMO_MODE: scheduled posts get published, metrics refreshed (the
 * channel's meta carries the audience used by simMetrics(), so refreshed numbers match the seeded
 * ones) and tokens refreshed as time goes by. Images and clips live in public/demo/.
 */

export interface DemoSocialOptions {
  adminId: number;
  /** Absolute site URL ("" = media URLs relative to the site). */
  siteUrl: string;
  rand: () => number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const slots = (days: number[], times: string[]): QueueSlot[] => days.flatMap((day) => times.map((time) => ({ day, time })));
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

type Row<T extends keyof Database> = Insertable<Database[T]>;

interface Cap {
  text: string;
  /** Text for X / Bluesky when `text` is long. */
  short?: string;
  img?: string;
  video?: string;
  link?: string;
  linkTitle?: string;
  firstComment?: string;
  thread?: string[];
  ytTitle?: string;
  labels?: string[];
  /** Only these platforms (e.g. LinkedIn-only company news). */
  only?: Platform[];
  evergreen?: boolean;
}

interface Ch {
  id: number;
  ws: number;
  key: string;
  platform: Platform;
  name: string;
  handle: string;
  followers: number;
  tz: string;
  slots: QueueSlot[];
  status: "active" | "expired";
  /** Publishing stopped working at (expired channels). */
  brokenAt?: number;
}

interface Attempt {
  outcome: string;
  error: string | null;
  kind: string | null;
  at: number;
  ms: number;
}

interface Tgt {
  id: number;
  ch: Ch;
  override: Record<string, unknown>;
  status: TargetStatus;
  publishedAt: number | null;
  attempts: Attempt[];
  error: string | null;
  errorKind: string | null;
  quotaMonth: string | null;
  extId: string | null;
}

interface Post {
  id: number;
  ws: number;
  ownerId: number;
  author: number;
  status: "draft" | "pending_approval" | "scheduled" | "published" | "partially_failed" | "failed";
  at: number | null;
  cap: Cap;
  content: string;
  labels: string[];
  source: "manual" | "rss" | "recycle";
  sourceRef: string | null;
  evergreen: boolean;
  recycleCount: number;
  lastRecycledAt: number | null;
  approvedBy: number | null;
  approvedAt: number | null;
  publishedAt: number | null;
  createdAt: number;
  targets: Tgt[];
}

// ── Content ──

const LUMEN_TAGS = "#brooklyn #bakery #sourdough #croissant #pastrylove #brooklynfood #nyceats";
const LUMEN_IMG: Cap[] = [
  { text: "Maple pecan croissants are back this weekend 🥐 Laminated with brown butter, finished with a maple glaze and toasted pecans. They sell out by 10, so come early!", img: "lumen-croissant", firstComment: LUMEN_TAGS, evergreen: true },
  { text: "Coffee + croissant for $6, every weekday before 9 am ☕ The best way to start a Monday, honestly. Bring your own cup and we knock off another 50¢.", img: "lumen-coffee", firstComment: LUMEN_TAGS, evergreen: true },
  { text: "Pumpkin pie pre-orders are open 🥧 Spiced custard, a flaky all-butter crust and maple whipped cream on the side. Order online and pick it up warm.", img: "lumen-pie", link: "https://lumenandloaf.example/preorder", linkTitle: "Pie pre-orders", firstComment: LUMEN_TAGS, labels: ["Holidays"] },
  { text: "Learn to bake bread with us! 👩‍🍳 Our Sunday workshop covers starters, shaping and scoring. 8 seats, flour and coffee included, and you take two loaves home.", img: "lumen-workshop", link: "https://lumenandloaf.example/workshops", linkTitle: "Bread workshops", firstComment: "Questions about the workshop? Drop them below 👇", evergreen: true },
  { text: "Our autumn menu is here 🍂 Apple cider loaf, chai cinnamon buns and a pear-frangipane tart. Which one are you trying first?", img: "lumen-autumn", firstComment: LUMEN_TAGS, labels: ["Autumn menu"] },
  { text: "Three days, 27 layers, one very flaky croissant 🥐 Our maple pecan batch is laminated by hand every Thursday.", img: "lumen-croissant", firstComment: LUMEN_TAGS, evergreen: true },
  { text: "Croissant math: 81 layers of butter and dough, 18 minutes in the oven, about 4 seconds on the counter before someone grabs it 🥐", img: "lumen-croissant", firstComment: LUMEN_TAGS },
  { text: "New on the coffee bar: a maple oat latte ☕ Pairs suspiciously well with anything flaky.", img: "lumen-coffee", firstComment: LUMEN_TAGS },
  { text: "Our beans come from Parlor Coffee, roasted three blocks away ☕ Ask for the single origin of the week.", img: "lumen-coffee", firstComment: LUMEN_TAGS, evergreen: true },
  { text: "Apple-crumble pie is the quiet favourite this year 🍎 Order a whole one or grab a slice with your coffee.", img: "lumen-pie", firstComment: LUMEN_TAGS },
  { text: "Pie crust secret: cold butter, a splash of cider vinegar and a long rest in the fridge 🥧 That's it. That's the secret.", img: "lumen-pie", firstComment: LUMEN_TAGS, evergreen: true },
  { text: "Workshop recap: eight first-time bakers, sixteen loaves and one very proud sourdough starter named Gerald 🍞", img: "lumen-workshop", firstComment: LUMEN_TAGS },
  { text: "Gift idea: a bread workshop voucher 🎁 Valid for a year, flour and coffee included, two loaves to take home.", img: "lumen-workshop", link: "https://lumenandloaf.example/workshops", linkTitle: "Bread workshops", firstComment: LUMEN_TAGS },
  { text: "Apple cider loaf, fresh from the oven 🍂 Moist, warmly spiced and even better toasted with salted butter.", img: "lumen-autumn", firstComment: LUMEN_TAGS, labels: ["Autumn menu"] },
  { text: "Chai cinnamon buns are the autumn menu's runaway hit 🍂 Out of the oven at 8 and 11 every day.", img: "lumen-autumn", firstComment: LUMEN_TAGS, labels: ["Autumn menu"] },
];
const LUMEN_SOURDOUGH: Cap[] = [
  { text: "Sourdough Saturday 🍞 Our country loaf ferments for 48 hours and comes out of the oven at 7 am. Reserve yours online and skip the line.", img: "lumen-sourdough", link: "https://lumenandloaf.example/order", linkTitle: "Reserve a loaf", firstComment: LUMEN_TAGS },
  { text: "It's Sourdough Saturday! This week: rye & caraway, olive & rosemary and the classic country loaf. First batch out at 7 am 🍞", img: "lumen-sourdough", firstComment: LUMEN_TAGS },
  { text: "Sourdough Saturday tip: let your loaf cool for an hour before slicing. The crumb is still cooking! See you at the counter 🍞", img: "lumen-sourdough", firstComment: LUMEN_TAGS },
  { text: "Sourdough Saturday 🍞 New this week: a seeded spelt loaf with sunflower, flax and pumpkin seeds. Out at 7 am.", img: "lumen-sourdough", firstComment: LUMEN_TAGS },
  { text: "Sourdough Saturday: our starter turns 6 this month 🎂 Still fed twice a day, still bubbly, still the hardest worker here.", img: "lumen-sourdough", firstComment: LUMEN_TAGS },
  { text: "Sourdough Saturday! Bring back any Lumen bread bag and get 50¢ off your loaf 🍞 Small things, less waste.", img: "lumen-sourdough", firstComment: LUMEN_TAGS },
];
const PASTRIES = ["chai cinnamon buns", "almond croissants", "apple hand pies", "cardamom knots", "pear-frangipane tarts", "chocolate babka", "everything bagels", "brown butter cookies"];
const LUMEN_TEXT: Cap[] = [
  { text: "We're hiring! Looking for an early-morning baker (4 am starts, great coffee, weekends off). Apply in store or online.", link: "https://lumenandloaf.example/jobs", linkTitle: "Jobs at Lumen & Loaf" },
  { text: "Rainy day = cinnamon bun day. Warm ones out of the oven at 11 ☔" },
  { text: "Thank you for 10,000 followers! Free cookie with any coffee this Friday — just say \"Lumen\" at the counter 🍪" },
  { text: "Behind the scenes: our ovens fire up at 3:30 am. Three bakers, 40 kg of butter a week and one very loud radio." },
  { text: "Gluten-free brownies are back on the shelf. Fudgy, rich and baked in a dedicated gluten-free batch." },
  { text: "Local love: our flour comes from Hudson Valley Mill, 90 miles up the river 🌾 Stone-ground every Tuesday." },
  { text: "Important question: croissant or pain au chocolat? Wrong answers only 😄" },
  { text: "Saturday market pop-up at Fort Greene Park, 8 am – 1 pm. Look for the yellow tent!" },
  { text: "Leftover bread never goes to waste here: it becomes bread pudding, croutons for our neighbours at Café Sol, and the rest goes to the community fridge." },
  { text: "Catering for your office? Pastry boxes for 10 to 100 people, delivered before 9 am.", link: "https://lumenandloaf.example/catering", linkTitle: "Catering" },
  { text: "Sunday hours: 8 am – 2 pm. The everything bagels sell out first, just saying 🥯" },
  { text: "Staff favourite this week: the olive & rosemary focaccia. Ask for a warm slice." },
  { text: "Birthday cakes are on the menu: three days' notice, any flavour you can dream up 🎂" },
  { text: "Fun fact: we go through about 600 eggs a week. Thank you, Sunny Acres Farm 🐔" },
  { text: "Quiet hour tip: weekdays between 2 and 4 pm there's always a free table and fresh coffee." },
  { text: "Pastry of the month vote: cardamom knot or chocolate babka? Comment your pick!" },
  { text: "New loyalty card: ten coffees, and the eleventh is on us ☕" },
  { text: "Our bread is now on the menu at four Brooklyn cafés. Want it on yours? Send us a message." },
];
const lumenSpecial = (r: () => number): Cap => {
  const item = PASTRIES[Math.floor(r() * PASTRIES.length)];
  const forms = [`Fresh ${item} out of the oven right now. Come say hi!`, `Today's special: ${item} 🧡 Only two trays, so don't wait too long.`, `The ${item} are flying off the counter this morning. A few left!`];
  return { text: forms[Math.floor(r() * forms.length)] };
};

const ATLAS_IMG: Cap[] = [
  { text: "5 day hikes under 3 hours, picked by our store crew 🥾 From Breakneck Ridge to the Minnewaska carriage roads — full guide with maps and parking tips on the blog.", short: "5 day hikes under 3 hours, picked by our crew 🥾 Maps + parking tips on the blog.", img: "atlas-trail", link: "https://atlasoutdoor.example/blog/day-hikes", linkTitle: "5 day hikes under 3 hours", evergreen: true },
  { text: "Fall layering 101: a base layer to move sweat, a mid layer for warmth, a shell for wind and rain. The trick? Switch before you're cold, not after.", short: "Fall layering 101: base to move sweat, mid for warmth, shell for wind. Switch before you're cold, not after 🍂", img: "atlas-layering", link: "https://atlasoutdoor.example/blog/layering", linkTitle: "Fall layering 101", evergreen: true },
  { text: "Meet the Ridgeline 2P: 1.4 kg, two doors, two vestibules and a pitch time under two minutes. Now in store and online.", short: "Ridgeline 2P: 1.4 kg, two doors, pitches in under 2 minutes ⛺", img: "atlas-tent", link: "https://atlasoutdoor.example/ridgeline", linkTitle: "Ridgeline 2P tent", labels: ["Ridgeline launch"] },
  { text: "Trail Days are back: 20% off packs, tents and sleep systems this weekend. Members get early access the day before.", short: "Trail Days: 20% off packs, tents and sleep systems this weekend 🏕️", img: "atlas-sale", link: "https://atlasoutdoor.example/trail-days", linkTitle: "Trail Days sale", labels: ["Trail Days"] },
  { text: "Leave no trace: plan ahead, stay on durable surfaces, pack it out, leave what you find, keep fires small, respect wildlife and be kind to other hikers. 🌲", short: "Leave no trace: plan ahead, stay on trail, pack it out, respect wildlife 🌲", img: "atlas-leave-no-trace", evergreen: true },
  { text: "Sunrise hikes this weekend: Breakneck Ridge before 7 am means cool air, empty trails and the whole Hudson below you. Headlamps are 20% off for early starters.", short: "Sunrise hikes: Breakneck Ridge before 7 am = cool air and empty trails 🌄", img: "atlas-trail" },
  { text: "New to hiking? Start with the Minnewaska carriage roads: wide, gentle and full of views. Our beginner guide covers gear, water and timing.", short: "New to hiking? Start with the Minnewaska carriage roads 🥾 Beginner guide on the blog.", img: "atlas-trail", link: "https://atlasoutdoor.example/blog/first-hike", linkTitle: "Your first hike", evergreen: true },
  { text: "Cold hands, happy hiker? Not likely. Our glove guide: liners for the climb, insulated mitts for the summit and a spare pair in the pack.", short: "Glove guide: liners for the climb, mitts for the summit, a spare in the pack 🧤", img: "atlas-layering" },
  { text: "Merino or synthetic? Merino stays warm when wet and doesn't smell on day three; synthetic dries faster and costs less. Our staff pick: both, depending on the trip.", short: "Merino or synthetic base layers? Our staff explain the trade-offs 🐑", img: "atlas-layering", evergreen: true },
  { text: "Ridgeline 2P tip: pitch the fly first when it rains. The inner clips in from underneath and stays dry.", short: "Ridgeline 2P tip: pitch the fly first when it rains ⛺", img: "atlas-tent", labels: ["Ridgeline launch"] },
  { text: "Rent before you buy: the Ridgeline 2P is now in our rental fleet at $25 a weekend, and the fee comes off if you buy one.", short: "Rent a Ridgeline 2P for $25 a weekend ⛺ The fee comes off if you buy.", img: "atlas-tent", link: "https://atlasoutdoor.example/rentals", linkTitle: "Gear rentals" },
  { text: "Members' night on Thursday: 25% off everything from 6 to 9 pm, with snacks from Beacon Bread and gear demos all evening.", short: "Members' night on Thursday: 25% off from 6 to 9 pm 🏕️", img: "atlas-sale", labels: ["Trail Days"] },
  { text: "Gear swap Saturday: bring what you don't use, take what you need. Whatever's left goes to the local scouts.", short: "Gear swap Saturday: bring what you don't use, take what you need ♻️", img: "atlas-sale" },
  { text: "Trail crew day recap: 40 volunteers, 300 m of new tread and 12 bags of litter off Mt. Beacon. Thank you! 🌲", short: "Trail crew day: 40 volunteers, 300 m of new trail, 12 bags of litter 🌲", img: "atlas-leave-no-trace" },
  { text: "Campfire check: use existing rings, keep it small, burn only dead and down wood, and drown it until it's cold to the touch.", short: "Campfire check: existing rings, small fires, drown it cold 🔥", img: "atlas-leave-no-trace", evergreen: true },
];
const ATLAS_VIDEO: Cap[] = [
  { text: "Everything our guides carry for a long weekend on the trail, packed in 12 minutes: shelter, sleep, kitchen, water and the small stuff people forget.\n\nChapters:\n0:00 The list\n2:10 Shelter\n5:40 Kitchen\n9:30 What we leave at home", short: "New video: how we pack a 3-day kit in 12 minutes 🎒", video: "atlas-video-pack", ytTitle: "How we pack a 3-day kit in 12 minutes", link: "https://atlasoutdoor.example/videos/3-day-kit", linkTitle: "Pack a 3-day kit" },
  { text: "We took the Ridgeline 2P on 1,000 km of trail. Here's what held up, what wore out and what we'd change in version two.", short: "New video: the Ridgeline 2P after 1,000 km — an honest review ⛺", video: "atlas-video-review", ytTitle: "Ridgeline 2P after 1,000 km: honest long-term review", link: "https://atlasoutdoor.example/videos/ridgeline-review", linkTitle: "Ridgeline long-term review" },
  { text: "The 3-day kit, kitchen edition: stove, pot, spork and the one spice blend our guides never leave behind.", short: "New video: our 3-day kitchen kit in 12 minutes 🍳", video: "atlas-video-pack", ytTitle: "Backpacking kitchen kit: what our guides carry", link: "https://atlasoutdoor.example/videos/kitchen-kit", linkTitle: "Backpacking kitchen kit" },
  { text: "Ridgeline 2P vs. our old favourite: weight, space, wind and how fast each one pitches in the dark.", short: "New video: the Ridgeline 2P vs. our old favourite tent ⛺", video: "atlas-video-review", ytTitle: "Ridgeline 2P vs. the classic: a side-by-side test", link: "https://atlasoutdoor.example/videos/ridgeline-vs-classic", linkTitle: "Ridgeline 2P side by side" },
];
const ATLAS_LI: Cap[] = [
  { text: "We're hiring a Store Lead for our Beacon location. If you love the outdoors and building great teams, we'd love to hear from you.", link: "https://atlasoutdoor.example/careers", linkTitle: "Careers at Atlas Outdoor", only: ["linkedin"] },
  { text: "Our impact report is out: 1% of sales to trail conservation, 4,200 volunteer hours and 38 repair cafés across the Hudson Valley.", link: "https://atlasoutdoor.example/impact", linkTitle: "Impact report", only: ["linkedin", "x"], short: "Our impact report: 1% of sales to trail conservation and 4,200 volunteer hours 🌲" },
  { text: "Repair, don't replace: our repair desk fixed 1,100 zippers, seams and tent poles this year. Bring your gear in — most fixes take under a week.", short: "Our repair desk fixed 1,100 zippers, seams and poles this year 🧵", evergreen: true },
  { text: "Proud to partner with the Hudson Highlands Trail Conference: our team will rebuild 2 km of trail this season.", only: ["linkedin"] },
  { text: "Atlas Outdoor turns 12 this month. From a 40 m² shop in Beacon to three stores and a repair desk: thank you to our team and our community.", short: "Atlas Outdoor turns 12 this month 🎉 Thank you to our team and community.", only: ["linkedin", "x"] },
  { text: "Our staff trip this year: three days on the Devil's Path to test next season's gear. Field notes coming soon.", short: "Staff trip: three days on the Devil's Path testing next season's gear 🎒" },
  { text: "We're now a certified B Corp. It took two years, a lot of paperwork and a supplier code we're proud of.", only: ["linkedin"] },
];
const TRAILS = ["Breakneck Ridge", "Mt. Beacon", "Bear Mountain", "Minnewaska", "Storm King", "Anthony's Nose", "Kaaterskill Falls", "Sam's Point"];
const CONDITIONS = ["dry and busy", "muddy after the rain", "covered in leaves — watch your step", "quiet on weekday mornings", "windy at the top"];
const atlasReport = (r: () => number): Cap => {
  const trail = TRAILS[Math.floor(r() * TRAILS.length)];
  const cond = CONDITIONS[Math.floor(r() * CONDITIONS.length)];
  const tips = ["Go early and bring water.", "Trekking poles help on the descent.", "Parking fills up by 9 am.", "Pack a warm layer for the summit."];
  return { text: `Trail report: ${trail} is ${cond}. ${tips[Math.floor(r() * tips.length)]} 🍂`, only: ["x"] };
};
const ATLAS_X: Cap[] = [
  { text: "First frost up north this week. Time to swap the summer bag for the 20°F one.", only: ["x"] },
  { text: "What's the one item you never hike without? Ours: a headlamp. Every. Single. Time.", only: ["x"] },
  { text: "Sunrise from the Mt. Beacon fire tower this morning. Worth the 5 am alarm.", only: ["x"] },
  { text: "Hot take: the best hiking snack is a cold boiled potato with salt. Fight us.", only: ["x"] },
  { text: "Hunting season starts this weekend: wear blaze orange on the trail 🧡", only: ["x"] },
  { text: "Fastest way to stay warm at a summit: put your puffy on before you stop, not after.", only: ["x"] },
  { text: "Overheard at the register: \"Do I really need a map if I have my phone?\" Yes. Yes, you do.", only: ["x"] },
  {
    text: "6 things we learned guiding 400 hikes this summer 🧵",
    thread: [
      "1/ Most people start too fast. The first 20 minutes should feel easy.",
      "2/ Water: half a litre per hour in the heat, and drink before you're thirsty.",
      "3/ Cotton is fine — until it rains. Then it's not fine.",
      "4/ Download the map offline. Cell service ends where the views start.",
      "5/ Turnaround time beats summit fever. The mountain will be there next week.",
      "6/ Snacks are morale. Pack one more than you think.",
    ],
    only: ["x"],
    evergreen: true,
  },
];

const PALETTES = ["Dusk orchard", "Harbor fog", "Autumn market", "Neon noodle bar", "Desert dawn", "Moss & moth", "Winter citrus", "Old library", "Tidepool", "Plum jam", "Paper lanterns", "Forest floor", "Lavender storm"];
const MAYA_TIPS = [
  "Sketchbook tip: draw the same object five times in five minutes. The fifth one is always the best.",
  "Colour tip: pick your shadow colour first, then build the light around it. Moodier pieces, every time.",
  "Reminder that \"done\" beats \"perfect\". Posting the messy sketch anyway ✏️",
  "Procreate tip: a multiply layer clipped to your line art at 30% = instant depth.",
  "Studio note: I keep a \"bad drawings\" folder. It's the most useful folder I have.",
  "Warm-up I do every morning: 10 gesture drawings, 30 seconds each, no erasing.",
  "Lighting tip: rim light is a cheat code. One bright edge and the character pops off the page.",
  "Composition tip: squint at your canvas. If it still reads, the values work.",
  "Brush tip: fewer brushes, better work. I do 90% of a piece with three of them.",
  "Reference tip: shoot your own. Your phone and a desk lamp beat any stock photo.",
  "Studio note: I stop each session mid-stroke on purpose, so tomorrow I know exactly where to start.",
  "Texture tip: add grain last, at 10–15% opacity. Any more and it turns into noise.",
];
const MAYA_TEXT: Cap[] = [
  { text: "Commissions for December are open — 3 slots for pet portraits and book covers. Details and prices on my site.", link: "https://mayacreates.example/commissions", linkTitle: "Commissions" },
  { text: "My newsletter goes out tomorrow: studio notes, a free colouring page and the brush I use the most.", link: "https://mayacreates.example/newsletter", linkTitle: "Studio notes newsletter", evergreen: true },
  { text: "What should Palette Monday be next week? Autumn forest, neon city or desert dawn? 🎨" },
  { text: "Behind the scenes: my desk, three cold coffees and a very supportive cat 🐈" },
  { text: "Thank you for 15k! Giveaway: 3 copies of the Grain & Glow brush pack. Reply with your favourite colour to enter 💜" },
  {
    text: "How I colour a picture book spread, start to finish 🧵",
    thread: [
      "1. Thumbnails first: six tiny versions, pick the clearest silhouette.",
      "2. Flat colours on separate layers, no shading yet.",
      "3. One light source. Shadows in a single multiply layer.",
      "4. Texture last: grain brush at low opacity over everything.",
      "5. Flip the canvas. Fix what looks wrong. Repeat.",
    ],
    evergreen: true,
  },
  { text: "Sketchbook tour on the blog: 60 pages of autumn studies, coffee stains included ☕", link: "https://mayacreates.example/blog/autumn-sketchbook", linkTitle: "My autumn sketchbook" },
  { text: "Print shop restock: the lighthouse keeper and the night garden are back in A4 and A3.", link: "https://mayacreates.example/shop/prints", linkTitle: "Art prints" },
  { text: "Question for fellow illustrators: how do you price rush jobs? I'm rethinking my rates." },
  { text: "Picture book update: 24 of 32 spreads coloured. The finish line is in sight 📚" },
];
const MAYA_IMG: Cap[] = [
  { text: "New brush pack! Grain & Glow: 24 textured brushes for Procreate — grainy shaders, soft glows and dry ink. Launch price €9 this week.", img: "maya-brushes", link: "https://mayacreates.example/shop/grain-glow", linkTitle: "Grain & Glow brush pack", labels: ["Grain & Glow"] },
  { text: "WIP from chapter 3 of the picture book: the lighthouse keeper at dusk. Still fighting with those waves 😅", img: "maya-lighthouse" },
  { text: "Live drawing stream on Thursday at 7 pm CET! Bring a prompt and I'll sketch it live 🎨", img: "maya-live", link: "https://mayacreates.example/live", linkTitle: "Live drawing stream", labels: ["Live"] },
  { text: "Lighthouse keeper, take two: warmer sky, calmer sea. Better? 🌅", img: "maya-lighthouse" },
  { text: "Grain & Glow in action: every texture in this piece comes from the pack ✨ Brush names in the replies.", img: "maya-brushes", link: "https://mayacreates.example/shop/grain-glow", linkTitle: "Grain & Glow brush pack", labels: ["Grain & Glow"] },
  { text: "Live tonight at 7 pm CET! Prompts so far: a cat astronaut and a haunted teapot 🎨", img: "maya-live", link: "https://mayacreates.example/live", linkTitle: "Live drawing stream", labels: ["Live"] },
];
const SKETCH_SUBJECTS = ["a fox in a raincoat", "a tiny lighthouse in a teacup", "a bookshop cat asleep on the till", "a dragon learning to knit", "a rainy tram stop", "an owl with reading glasses", "a robot watering tomatoes", "a hedgehog café"];
const mayaSketch = (r: () => number): Cap => {
  const subject = SKETCH_SUBJECTS[Math.floor(r() * SKETCH_SUBJECTS.length)];
  const forms = [`Sketch of the day: ${subject} ✏️`, `Today's warm-up sketch: ${subject}. Ten minutes, no undo.`, `Doodle break: ${subject} 🎨`];
  return { text: forms[Math.floor(r() * forms.length)] };
};

// ── Helpers ──

/** Local "YYYY-MM-DD" days of a time zone from `from` to `to` days around now, each once. */
function localDays(nowMs: number, tz: string, from: number, to: number): Array<{ y: number; m: number; d: number; weekday: number; offset: number }> {
  const seen = new Set<string>();
  const out: Array<{ y: number; m: number; d: number; weekday: number; offset: number }> = [];
  for (let k = from; k <= to; k++) {
    const day = localDay(nowMs + k * DAY, tz);
    if (seen.has(day)) continue;
    seen.add(day);
    const [y, m, d] = day.split("-").map(Number);
    out.push({ y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7, offset: k });
  }
  return out;
}

const at = (day: { y: number; m: number; d: number }, time: string, tz: string) => {
  const [hour, minute] = time.split(":").map(Number);
  return zonedTimeToUtc({ year: day.y, month: day.m, day: day.d, hour, minute }, tz);
};

/** Fits `text` into a platform's limit (X counts URLs as 23 and emoji as 2: keep a margin). */
function fits(text: string, platform: Platform): boolean {
  const max = PLATFORM_CAPABILITIES[platform].text.max;
  const weight = platform === "x" ? [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0x2000 ? 2 : 1), 0) : [...text].length;
  return weight <= max - 5;
}

export async function seedDemoSocial(trx: Transaction<Database>, options: DemoSocialOptions): Promise<Record<string, number>> {
  const { adminId, rand: r } = options;
  const NOW = Date.now();
  const base = options.siteUrl.replace(/\/+$/, "");
  const between = (a: number, b: number) => a + r() * (b - a);
  const chance = (p: number) => r() < p;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];
  const month = (ms: number) => iso(ms).slice(0, 7);

  // Ids: explicit, continuing after whatever exists (multi-row inserts don't report every id on all databases).
  const nextId: Record<string, number> = {};
  for (const table of ["workspaces", "workspace_members", "workspace_invites", "channels", "posts", "post_targets", "media_folders", "media", "rss_feeds", "rss_items", "short_links", "post_metrics", "approval_links", "post_comments", "post_attempts", "api_keys", "notify_channels", "alert_log"] as const) {
    const res = await sql<{ m: number | null }>`select max(id) as m from ${sql.table(table)}`.execute(trx);
    nextId[table] = Number(res.rows[0]?.m ?? 0) + 1;
  }
  const id = (table: string) => nextId[table]++;

  // People: two sample users join the agency team, three paying customers get a workspace of their own.
  const sample = await trx.selectFrom("users").select(["id", "name", "plan_id"]).where("role", "=", "user").where("status", "=", "active").orderBy("id").execute();
  const team = sample.filter((u) => !u.plan_id).slice(0, 2);
  const customers = sample.filter((u) => u.plan_id).slice(0, 3);
  const editorId = team[0]?.id ?? adminId;
  const approverId = team[1]?.id ?? adminId;
  const nameOf = new Map(sample.map((u) => [u.id, u.name]));
  const adminRow = await trx.selectFrom("users").select("name").where("id", "=", adminId).executeTakeFirst();
  nameOf.set(adminId, adminRow?.name ?? "Admin");

  const rows = {
    workspaces: [] as Row<"workspaces">[],
    workspace_members: [] as Row<"workspace_members">[],
    workspace_invites: [] as Row<"workspace_invites">[],
    channels: [] as Row<"channels">[],
    media_folders: [] as Row<"media_folders">[],
    media: [] as Row<"media">[],
    posts: [] as Row<"posts">[],
    post_targets: [] as Row<"post_targets">[],
    post_attempts: [] as Row<"post_attempts">[],
    post_metrics: [] as Row<"post_metrics">[],
    post_comments: [] as Row<"post_comments">[],
    rss_feeds: [] as Row<"rss_feeds">[],
    rss_items: [] as Row<"rss_items">[],
    short_links: [] as Row<"short_links">[],
    link_clicks_daily: [] as Row<"link_clicks_daily">[],
    approval_links: [] as Row<"approval_links">[],
    api_keys: [] as Row<"api_keys">[],
    notify_channels: [] as Row<"notify_channels">[],
    alert_log: [] as Row<"alert_log">[],
    usage_monthly: [] as Row<"usage_monthly">[],
    platform_usage_daily: [] as Row<"platform_usage_daily">[],
  };

  // ── Workspaces ──
  const NY = "America/New_York";
  const BERLIN = "Europe/Berlin";
  const np = id("workspaces");
  const maya = id("workspaces");
  rows.workspaces.push(
    {
      id: np,
      owner_id: adminId,
      name: "Northpeak Studio",
      timezone: NY,
      settings: JSON.stringify({
        approvalRequired: true,
        defaultSlots: slots(WEEKDAYS, ["09:00", "12:30", "18:00"]),
        weekStart: 1,
        utm: { enabled: true, source: "{platform}", medium: "social", campaign: "northpeak" },
        shortenLinks: true,
        branding: { companyName: "Northpeak Studio", logo: "/demo/avatars/northpeak-logo.png", color: "#0f766e" },
      }),
      is_personal: 1,
      recycle_settings: JSON.stringify({ enabled: true, intervalDays: 21, maxRecycles: 4, channelIds: [], randomize: false, perRun: 2 }),
      created_at: iso(NOW - 120 * DAY),
      updated_at: iso(NOW - 2 * DAY),
    },
    {
      id: maya,
      owner_id: adminId,
      name: "Maya Creates",
      timezone: BERLIN,
      settings: JSON.stringify({
        approvalRequired: false,
        defaultSlots: slots(WEEKDAYS, ["10:00", "19:00"]),
        weekStart: 1,
        utm: { enabled: false, source: "{platform}", medium: "social", campaign: "" },
        shortenLinks: false,
        branding: { companyName: "", logo: "", color: "" },
      }),
      is_personal: 0,
      recycle_settings: JSON.stringify({ enabled: true, intervalDays: 30, maxRecycles: 3, channelIds: [], randomize: false, perRun: 1 }),
      created_at: iso(NOW - 110 * DAY),
      updated_at: iso(NOW - 5 * DAY),
    },
  );
  const member = (ws: number, user: number, role: Row<"workspace_members">["role"], daysAgo: number) =>
    rows.workspace_members.push({ id: id("workspace_members"), workspace_id: ws, user_id: user, role, created_at: iso(NOW - daysAgo * DAY) });
  member(np, adminId, "owner", 120);
  if (editorId !== adminId) member(np, editorId, "editor", 100);
  if (approverId !== adminId) member(np, approverId, "approver", 98);
  member(maya, adminId, "owner", 110);
  rows.workspace_invites.push({ id: id("workspace_invites"), workspace_id: np, email: "lena@lumenandloaf.example", role: "approver", token_hash: sha256(crypto.randomBytes(24).toString("hex")), invited_by: adminId, expires_at: iso(NOW + 12 * DAY), created_at: iso(NOW - 2 * DAY) });

  // ── Channels ──
  const secret = await getAppSecret(trx);
  const since = iso(NOW - 100 * DAY);
  const channels: Ch[] = [];
  const addChannel = (ws: number, key: string, platform: Platform, name: string, handle: string, avatar: string, followers: number, tz: string, queue: QueueSlot[], extra: { status?: "expired"; brokenDaysAgo?: number; error?: string; expiresInMs?: number | null; defaultFirstComment?: string; hashtags?: string; created?: number } = {}) => {
    const ch: Ch = { id: id("channels"), ws, key, platform, name, handle, followers, tz, slots: queue, status: extra.status ?? "active", brokenAt: extra.brokenDaysAgo ? NOW - extra.brokenDaysAgo * DAY : undefined };
    channels.push(ch);
    const ttl = PLATFORM_CAPABILITIES[platform].auth.accessTtl;
    const expires = extra.expiresInMs !== undefined ? (extra.expiresInMs === null ? null : NOW + extra.expiresInMs) : ttl ? NOW + Math.min(ttl * 1000, 40 * DAY) * between(0.5, 0.95) : null;
    const externalId = `demo-${platform}-${simHash(`${ws}:${key}`).toString(36)}`;
    const slug = handle.replace(/^[@#]/, "").split("@")[0] || key;
    const credentials =
      platform === "telegram"
        ? { botToken: `7000${simHash(key) % 100000}:AAdemo${simHash(name).toString(36)}`, chatId: handle }
        : platform === "discord"
          ? { webhookUrl: `https://discord.example/api/webhooks/${simHash(key)}/demo` }
          : platform === "bluesky"
            ? { identifier: handle.replace(/^@/, ""), appPassword: "demo-demo-demo-demo", session: { accessJwt: "demo", refreshJwt: "demo", did: `did:plc:demo${simHash(key).toString(36)}` } }
            : { accessToken: `sim_${externalId}_${NOW.toString(36)}`, refreshToken: ttl ? `simr_${externalId}` : undefined, expiresAt: expires ? iso(expires) : null, ...(platform === "mastodon" ? { instanceUrl: "https://art.example" } : {}) };
    const meta: Record<string, unknown> = { followers, audienceTz: tz, audienceSince: since };
    if (platform === "linkedin" && expires) meta.expiryReminderFor = iso(expires); // reminder already sent (see alert_log)
    const created = extra.created ?? NOW - between(92, 100) * DAY;
    rows.channels.push({
      id: ch.id,
      workspace_id: ws,
      platform,
      external_id: externalId,
      name,
      handle,
      avatar_url: `/demo/avatars/${avatar}.png`,
      profile_url: `https://example.social/${platform}/${encodeURIComponent(slug)}`,
      credentials: encryptWith(secret, JSON.stringify(credentials), "channel-credentials"),
      token_expires_at: expires ? iso(expires) : null,
      status: ch.status,
      last_error: extra.error ?? null,
      last_checked_at: iso(extra.brokenDaysAgo ? NOW - extra.brokenDaysAgo * DAY : NOW - between(1, 20) * HOUR),
      settings: JSON.stringify({ defaultFirstComment: extra.defaultFirstComment ?? "", hashtags: extra.hashtags ?? "", utm: null, defaults: {} }),
      queue_slots: JSON.stringify(queue),
      meta: JSON.stringify(meta),
      connected_by: adminId,
      queue_paused: 0,
      created_at: iso(created),
      updated_at: iso(NOW - between(1, 10) * DAY),
    });
    return ch;
  };

  const lumenSlots = [...slots([1, 2, 3, 4, 5, 6], ["08:00", "12:30"]), { day: 7, time: "10:00" }];
  const lIg = addChannel(np, "lumen-ig", "instagram", "Lumen & Loaf", "@lumenloaf", "lumenloaf", 18_400, NY, lumenSlots, { defaultFirstComment: LUMEN_TAGS });
  const lFb = addChannel(np, "lumen-fb", "facebook", "Lumen & Loaf Bakery", "", "lumenloaf", 9_200, NY, lumenSlots);
  const lTh = addChannel(np, "lumen-th", "threads", "Lumen & Loaf", "@lumenloaf", "lumenloaf", 3_100, NY, lumenSlots);
  const aX = addChannel(np, "atlas-x", "x", "Atlas Outdoor", "@atlasoutdoor", "atlas", 24_800, NY, slots(WEEKDAYS, ["09:00", "13:00", "18:00"]), { expiresInMs: 95 * MIN });
  const aLi = addChannel(np, "atlas-li", "linkedin", "Atlas Outdoor Co.", "", "atlas", 7_600, NY, slots([2, 4], ["10:00"]), { expiresInMs: 5 * DAY - 3 * HOUR });
  const aYt = addChannel(np, "atlas-yt", "youtube", "Atlas Outdoor", "@atlasoutdoor", "atlas", 41_200, NY, [...slots([3], ["17:00"]), ...slots([6], ["10:00"])], { expiresInMs: 38 * MIN });
  const aIg = addChannel(np, "atlas-ig", "instagram", "Atlas Outdoor", "@atlas.outdoor", "atlas", 32_500, NY, [...slots([1, 3, 5], ["18:00"]), { day: 6, time: "11:00" }]);
  const mayaSlots = slots(WEEKDAYS, ["10:00", "19:00"]);
  const mBs = addChannel(maya, "maya-bsky", "bluesky", "Maya Lindqvist", "@mayacreates.bsky.social", "maya", 6_900, BERLIN, mayaSlots);
  const mMa = addChannel(maya, "maya-masto", "mastodon", "Maya Creates", "@maya@art.example", "maya", 2_400, BERLIN, mayaSlots);
  const mTg = addChannel(maya, "maya-tg", "telegram", "Maya Creates · Studio notes", "@mayacreates_studio", "maya", 1_850, BERLIN, slots([1, 4], ["20:00"]));
  const mDc = addChannel(maya, "maya-dc", "discord", "Maya's Studio", "#announcements", "maya", 1_200, BERLIN, slots([5], ["18:00"]));
  const mX = addChannel(maya, "maya-x", "x", "Maya Lindqvist", "@mayacreates", "maya", 15_300, BERLIN, mayaSlots, { expiresInMs: 70 * MIN });
  const mTh = addChannel(maya, "maya-th", "threads", "Maya Lindqvist", "@maya.creates", "maya", 8_700, BERLIN, mayaSlots, {
    status: "expired",
    brokenDaysAgo: 6,
    expiresInMs: 34 * DAY,
    error: "Error validating access token: the session has been invalidated because the user changed their password or Meta has changed the session for security reasons.",
  });

  // ── Media library ──
  const media = new Map<string, number>();
  const folders = new Map<string, number>();
  const folder = (ws: number, name: string, daysAgo: number) => {
    const fid = id("media_folders");
    rows.media_folders.push({ id: fid, workspace_id: ws, parent_id: null, name, created_at: iso(NOW - daysAgo * DAY) });
    folders.set(`${ws}:${name}`, fid);
    return fid;
  };
  const url = (path: string) => `${base}${path}`;
  const FILES: Array<[string, number, string, number, number, number, string, number | null]> = [
    // name, workspace, folder, width, height, bytes, alt text, video seconds
    ["lumen-croissant", np, "Lumen & Loaf", 800, 1000, 43_794, "A maple pecan croissant on a cream background with the words Maple pecan croissant, back this weekend", null],
    ["lumen-sourdough", np, "Lumen & Loaf", 800, 1000, 36_977, "A loaf of sourdough bread on terracotta with the words Sourdough Saturday", null],
    ["lumen-coffee", np, "Lumen & Loaf", 800, 1000, 42_595, "A cup of coffee with the words Coffee and croissant 6 dollars, every weekday before 9 am", null],
    ["lumen-pie", np, "Lumen & Loaf", 800, 1000, 34_445, "A pumpkin pie on orange with the words Pumpkin pie season, pre-orders open", null],
    ["lumen-workshop", np, "Lumen & Loaf", 800, 1000, 41_681, "A baker with the words Bread workshop, Sunday 10 am, 8 seats", null],
    ["lumen-autumn", np, "Lumen & Loaf", 800, 1000, 33_348, "Autumn leaves with the words Our autumn menu is here", null],
    ["atlas-trail", np, "Atlas Outdoor", 1000, 1000, 42_032, "Layered green mountains under a warm sky with the words 5 day hikes under 3 hours", null],
    ["atlas-layering", np, "Atlas Outdoor", 1000, 1000, 38_784, "A jacket above mountains with the words Fall layering 101", null],
    ["atlas-tent", np, "Atlas Outdoor", 1000, 1000, 41_630, "A green tent under a starry night sky with the words Ridgeline 2P tent", null],
    ["atlas-sale", np, "Atlas Outdoor", 1000, 1000, 41_630, "Mountains at sunset with the words Trail Days, 20 percent off", null],
    ["atlas-leave-no-trace", np, "Atlas Outdoor", 1000, 1000, 35_737, "A pine tree in front of mountains with the words Leave no trace", null],
    ["atlas-video-pack", np, "Atlas Outdoor", 640, 360, 50_692, "", 6.2],
    ["atlas-video-review", np, "Atlas Outdoor", 640, 360, 51_812, "", 6.2],
    ["maya-palette-41", maya, "Palette Monday", 1000, 1000, 48_128, "Five colour swatches: plum, fig, ember, pear and leaf", null],
    ["maya-palette-42", maya, "Palette Monday", 1000, 1000, 46_429, "Five colour swatches in muted blues: deep, slate, fog, mist and foam", null],
    ["maya-brushes", maya, "", 1000, 1000, 47_303, "Five textured brush strokes in violet, pink, cyan, amber and ink", null],
    ["maya-lighthouse", maya, "", 1000, 1000, 47_072, "Work in progress: a lighthouse on a cliff at dusk above purple waves", null],
    ["maya-live", maya, "", 1000, 1000, 38_549, "A painter's palette with a LIVE badge: live drawing stream on Thursday", null],
  ];
  folder(np, "Lumen & Loaf", 95);
  folder(np, "Atlas Outdoor", 95);
  folder(maya, "Palette Monday", 90);
  FILES.forEach(([name, ws, dir, width, height, size, alt, seconds], i) => {
    const mid = id("media");
    media.set(name, mid);
    const video = seconds !== null;
    const file = `${name}.${video ? "mp4" : "jpg"}`;
    rows.media.push({
      id: mid,
      workspace_id: ws,
      folder_id: dir ? (folders.get(`${ws}:${dir}`) ?? null) : null,
      uploaded_by: ws === np && i % 3 === 1 && editorId !== adminId ? editorId : adminId,
      storage: "local",
      storage_key: `demo/${file}`,
      url: url(`/demo/media/${file}`),
      filename: file,
      mime: video ? "video/mp4" : "image/jpeg",
      kind: video ? "video" : "image",
      size,
      width,
      height,
      duration: seconds,
      alt_text: alt,
      thumbnail_url: video ? url(`/demo/media/${name}.jpg`) : null,
      created_at: iso(NOW - (94 - i * 2) * DAY),
    });
  });

  // ── Posts ──
  const posts: Post[] = [];
  const contentOf = (cap: Cap) =>
    JSON.stringify(
      normalizePostContent({
        text: cap.text,
        mediaIds: [cap.img, cap.video].filter(Boolean).map((n) => media.get(n!)!),
        link: cap.link ?? "",
        linkMeta: cap.link ? { title: cap.linkTitle ?? "", description: "", imageUrl: cap.img ? url(`/demo/media/${cap.img}.jpg`) : "" } : null,
        firstComment: cap.firstComment ?? "",
        thread: cap.thread ?? [],
        options: cap.ytTitle ? { youtube: { title: cap.ytTitle, privacy: "public", tags: ["hiking", "gear", "backpacking"], categoryId: "19", madeForKids: false, notifySubscribers: true, thumbnailMediaId: 0 } } : {},
      }),
    );
  const overrideFor = (cap: Cap, ch: Ch): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    if (cap.short && (ch.platform === "x" || ch.platform === "bluesky" || ch.platform === "threads" || !fits(cap.text, ch.platform))) o.text = cap.short;
    if (cap.video && ch.platform !== "youtube") {
      o.mediaIds = [];
      if (cap.link && !cap.short) o.text = `${cap.text.split("\n")[0]}`;
    }
    if (cap.firstComment && PLATFORM_CAPABILITIES[ch.platform].firstComment === "none") o.firstComment = "";
    if (cap.link && PLATFORM_CAPABILITIES[ch.platform].links === "none") o.link = "";
    return o;
  };

  // Captions per channel (base text -> times): a channel doesn't get the same caption twice within
  // 14 days (recycled copies, 21+ days apart, are the intended exception).
  const REPEAT_GAP = 14 * DAY;
  const usedOn = new Map<number, Map<string, number[]>>();
  const clashes = (cap: Cap, ch: Ch, when: number) => (usedOn.get(ch.id)?.get(cap.text) ?? []).some((t) => Math.abs(t - when) < REPEAT_GAP);
  const remember = (cap: Cap, chs: Ch[], when: number) => {
    for (const ch of chs) {
      const m = usedOn.get(ch.id) ?? new Map<string, number[]>();
      usedOn.set(ch.id, m);
      m.set(cap.text, [...(m.get(cap.text) ?? []), when]);
    }
  };

  const brandLabel = (chs: Ch[]) => (chs.some((c) => c.key.startsWith("lumen")) ? "Lumen & Loaf" : chs.some((c) => c.key.startsWith("atlas")) ? "Atlas Outdoor" : null);

  /** Adds a post; `when` null = undated draft. Targets start "pending" and are finalised by the caller. */
  const addPost = (ws: number, ownerId: number, cap: Cap, chs: Ch[], when: number | null, status: Post["status"], author: number, extra: Partial<Post> = {}): Post => {
    const label = brandLabel(chs);
    const post: Post = {
      id: id("posts"),
      ws,
      ownerId,
      author,
      status,
      at: when,
      cap,
      content: contentOf(cap),
      labels: [...new Set([...(label ? [label] : []), ...(cap.labels ?? [])])],
      source: "manual",
      sourceRef: null,
      evergreen: false,
      recycleCount: 0,
      lastRecycledAt: null,
      approvedBy: null,
      approvedAt: null,
      publishedAt: null,
      createdAt: when ? Math.min(when - HOUR, NOW - between(0.2, 3) * DAY) : NOW - between(0.5, 6) * DAY,
      targets: chs.map((ch) => ({ id: id("post_targets"), ch, override: overrideFor(cap, ch), status: "pending", publishedAt: null, attempts: [], error: null, errorKind: null, quotaMonth: null, extId: null })),
      ...extra,
    };
    if (when && when < NOW) post.createdAt = when - between(0.3, 5) * DAY;
    if (when) remember(cap, chs, when);
    posts.push(post);
    return post;
  };

  const RETRY_ERRORS: Array<[string, string]> = [
    ["The platform returned 503 Service Unavailable. It will be retried.", "network"],
    ["Rate limit reached (429). Retrying after 60 s.", "rate_limit"],
    ["The connection timed out after 30 s. It will be retried.", "network"],
  ];
  /** Publishes a past post: every target published (a few after a retry). */
  const publish = (post: Post) => {
    for (const t of post.targets) {
      const start = post.at! + between(3, 40) * 1000;
      if (chance(0.04)) {
        const [error, kind] = pick(RETRY_ERRORS);
        t.attempts.push({ outcome: "retry", error, kind, at: start, ms: Math.round(between(800, 30_000)) });
        const second = start + 61_000 + between(0, 4000);
        t.attempts.push({ outcome: "published", error: null, kind: null, at: second, ms: Math.round(between(700, 2600)) });
        t.publishedAt = second + 2000;
      } else {
        t.attempts.push({ outcome: "published", error: null, kind: null, at: start, ms: Math.round(between(600, 2400)) });
        t.publishedAt = start + 1500 + between(0, 1500);
      }
      t.status = "published";
    }
    post.status = "published";
  };
  const schedule = (post: Post) => {
    for (const t of post.targets) {
      t.status = "scheduled";
      t.quotaMonth = month(post.createdAt);
    }
  };

  const editorShare = (ws: number) => (ws === np && editorId !== adminId ? 0.35 : 0);
  const approve = (post: Post) => {
    if (post.author === editorId && editorId !== adminId) {
      post.approvedBy = approverId;
      post.approvedAt = Math.min(post.createdAt + between(1, 20) * HOUR, NOW - between(10, 120) * MIN);
    }
  };

  // While the history is written, captions that ran on one of the brand's channels in the 14 days
  // around the post are left out of the draw (when every one did, any of them).
  let drawAt: { when: number; chs: Ch[] } | null = null;
  const pickCap = (list: Cap[]): Cap => {
    const near = drawAt;
    const ok = near ? list.filter((c) => !near.chs.some((ch) => clashes(c, ch, near.when))) : list;
    return pick(ok.length ? ok : list);
  };

  // History: 90 days, the posting rate grows over time (growth trend).
  type Brand = { ws: number; tz: string; rate: [number, number]; channels: Ch[]; make: (weekday: number, n: number) => { cap: Cap; chs: Ch[] } };
  let paletteNo = 42;
  const lumen: Brand = {
    ws: np,
    tz: NY,
    rate: [1.1, 1.8],
    channels: [lIg, lFb, lTh],
    make: (weekday, n) => {
      const cap = weekday === 6 && n === 0 && chance(0.85) ? pickCap(LUMEN_SOURDOUGH) : chance(0.45) ? pickCap(LUMEN_IMG) : chance(0.35) ? lumenSpecial(r) : pickCap(LUMEN_TEXT);
      const chs = cap.img ? [lIg, ...(chance(0.75) ? [lFb] : []), ...(chance(0.55) ? [lTh] : [])] : [...(chance(0.9) ? [lFb] : []), lTh];
      return { cap, chs };
    },
  };
  const atlas: Brand = {
    ws: np,
    tz: NY,
    rate: [1.1, 1.8],
    channels: [aX, aLi, aYt, aIg],
    make: (weekday) => {
      if ((weekday === 3 || weekday === 6) && chance(0.3)) {
        const cap = pickCap(ATLAS_VIDEO);
        return { cap, chs: [aYt, ...(chance(0.7) ? [aX] : [])] };
      }
      const roll = r();
      if (roll < 0.35) {
        const cap = pickCap(ATLAS_IMG);
        return { cap, chs: [aIg, ...(chance(0.7) ? [aX] : []), ...(chance(0.45) ? [aLi] : [])] };
      }
      if (roll < 0.55 && weekday <= 5) {
        const cap = pickCap(ATLAS_LI);
        return { cap, chs: cap.only ? channelsOf(cap.only, [aX, aLi]) : [aLi, aX] };
      }
      const cap = chance(0.55) ? atlasReport(r) : pickCap(ATLAS_X);
      return { cap, chs: [aX] };
    },
  };
  const channelsOf = (platforms: Platform[], from: Ch[]) => from.filter((c) => platforms.includes(c.platform));
  const mayaBrand: Brand = {
    ws: maya,
    tz: BERLIN,
    rate: [1.4, 2.3],
    channels: [mBs, mMa, mTg, mDc, mX, mTh],
    make: (weekday, n) => {
      let cap: Cap;
      if (weekday === 1 && n === 0) {
        const no = paletteNo--;
        cap = { text: `Palette Monday #${no}: ${PALETTES[no % PALETTES.length]} 🎨 Five colours for your next piece — free Procreate swatches in the link.`, img: no % 2 ? "maya-palette-41" : "maya-palette-42", link: "https://mayacreates.example/palettes", linkTitle: "Free palettes", labels: ["Palette Monday"] };
      } else {
        const roll = r();
        cap = roll < 0.22 ? pickCap(MAYA_IMG) : roll < 0.5 ? pickCap(MAYA_TIPS.map((text) => ({ text, evergreen: true }))) : roll < 0.68 ? mayaSketch(r) : pickCap(MAYA_TEXT);
      }
      const chs = [mBs, mMa, mX, mTh, mTg, mDc].filter((c) => {
        if (cap.thread && (c.platform === "telegram" || c.platform === "discord")) return false;
        const p = { bluesky: 0.92, mastodon: 0.78, x: 0.8, threads: 0.7, telegram: cap.link ? 0.6 : 0.25, discord: cap.labels?.length ? 0.7 : 0.12 }[c.platform as "x"] ?? 0;
        return chance(p);
      });
      return { cap, chs: chs.length ? chs : [mBs] };
    },
  };
  // Palette numbers count down from the most recent Monday: walk the days newest first.
  const historyFor = (brand: Brand) => {
    const days = localDays(NOW, brand.tz, -89, 0).reverse();
    for (const day of days) {
      const progress = (day.offset + 89) / 89;
      // A busier last week than the one before, so the overview's week-on-week trend points up.
      const rate = (brand.rate[0] + (brand.rate[1] - brand.rate[0]) * progress) * (day.offset > -7 ? 1.45 : day.offset > -14 ? 0.85 : 1);
      const count = Math.floor(rate) + (chance(rate - Math.floor(rate)) ? 1 : 0);
      const used = new Set<string>();
      const daySlots = [...new Set(brand.channels.flatMap((c) => c.slots.filter((s) => s.day === day.weekday).map((s) => s.time)))];
      for (let n = 0; n < count; n++) {
        let time = daySlots.length && chance(0.7) ? pick(daySlots) : `${String(Math.floor(between(7, 22))).padStart(2, "0")}:${pick(["00", "15", "30", "45"])}`;
        if (used.has(time)) time = `${String(Math.floor(between(7, 22))).padStart(2, "0")}:${pick(["05", "20", "40", "50"])}`;
        if (used.has(time)) continue;
        used.add(time);
        const when = at(day, time, brand.tz);
        if (when > NOW - 15 * MIN) continue;
        // Another caption when this one ran on one of the channels in the last 14 days (a few tries).
        drawAt = { when, chs: brand.channels };
        let made = brand.make(day.weekday, n);
        for (let k = 0; k < 10 && made.chs.some((c) => clashes(made.cap, c, when)); k++) made = brand.make(day.weekday, n);
        drawAt = null;
        const { cap, chs } = made;
        const live = chs.filter((c) => (!c.brokenAt || when < c.brokenAt) && !clashes(cap, c, when));
        if (!live.length) continue;
        const author = chance(editorShare(brand.ws)) ? editorId : adminId;
        const post = addPost(brand.ws, adminId, cap, live, when, "published", author);
        approve(post);
        publish(post);
      }
    }
  };
  historyFor(lumen);
  historyFor(atlas);
  historyFor(mayaBrand);

  // RSS-made posts (history) and the feeds' item log.
  const feedNp = id("rss_feeds");
  const feedMaya = id("rss_feeds");
  const journal = [
    ["How to choose a sleeping bag for shoulder season", "sleeping-bag-guide"],
    ["Trail journal: three days on the Devil's Path", "devils-path"],
    ["Waterproof vs. water-resistant: what the labels mean", "waterproof-labels"],
    ["Our favourite fire towers in the Catskills", "fire-towers"],
    ["A beginner's guide to hiking poles", "hiking-poles"],
    ["What we learned from 1,000 km in one tent", "tent-1000km"],
    ["Packing list: an overnight in late autumn", "overnight-autumn"],
    ["How to resole your hiking boots (and when not to)", "resole-boots"],
    ["Ten snacks our guides swear by", "trail-snacks"],
    ["Night hiking: gear, safety and the best full-moon trails", "night-hiking"],
    ["The Hudson Valley in five overlooks", "five-overlooks"],
    ["Map and compass: a 20-minute refresher", "map-compass"],
  ];
  const blog = [
    ["Studio notes: how I plan a 32-page picture book", "picture-book-plan"],
    ["Free colouring page: the lighthouse keeper", "colouring-lighthouse"],
    ["The five brushes I use every day", "five-brushes"],
    ["Pricing commissions without the guilt", "pricing-commissions"],
    ["My autumn sketchbook, page by page", "autumn-sketchbook"],
    ["How I made the Grain & Glow brushes", "grain-glow-making-of"],
    ["Colour theory for people who hate colour theory", "colour-theory"],
    ["A week in my studio, hour by hour", "studio-week"],
    ["Ten prompts for when you don't know what to draw", "ten-prompts"],
  ];
  const rssPosts = (feed: number, list: string[][], domain: string, chs: Ch[], ws: number, every: number, tz: string, tags: string) => {
    list.forEach(([title, slug], i) => {
      const itemId = id("rss_items");
      const published = NOW - (i * every + between(0.2, 2)) * DAY;
      const link = `https://${domain}/${slug}`;
      const posted = i < Math.ceil(list.length * 0.6) && chs.length;
      let postId: number | null = null;
      if (posted) {
        const day = localDays(published + 2 * HOUR, tz, 0, 0)[0];
        const slot = chs[0].slots.find((s) => s.day === day.weekday)?.time ?? "12:00";
        let when = at(day, slot, tz);
        if (when < published) when = published + 2 * HOUR;
        if (when < NOW - 15 * MIN) {
          const cap: Cap = { text: `${title}\n\n${link}${tags ? `\n\n${tags}` : ""}`, link };
          const post = addPost(ws, adminId, cap, chs.filter((c) => !c.brokenAt || when < c.brokenAt), when, "published", adminId, { source: "rss", sourceRef: String(itemId) });
          post.createdAt = published + 10 * MIN;
          publish(post);
          postId = post.id;
        }
      }
      rows.rss_items.push({ id: itemId, feed_id: feed, guid_hash: sha256(link), guid: link, url: link, title, published_at: iso(published), post_id: postId, created_at: iso(published + 10 * MIN) });
    });
  };
  rssPosts(feedNp, journal, "atlasoutdoor.example/journal", [aX, aLi], np, 7, NY, "#hiking");
  rssPosts(feedMaya, blog, "mayacreates.example/blog", [mBs, mMa, mTg], maya, 9, BERLIN, "");

  // ── Failures with real-looking errors (recent, so they show on the first pages) ──
  const fail = (daysAgo: number, platform: Platform, ws: number, error: string, kind: string, attempts: number, status: "failed" | "needs_reauth" = "failed", channel?: Ch) => {
    const target = NOW - daysAgo * DAY;
    const candidates = posts
      .filter((p) => p.ws === ws && p.status === "published" && p.source === "manual" && p.targets.some((t) => t.ch.platform === platform && (!channel || t.ch === channel)) && !p.targets.some((t) => t.status !== "published"))
      .sort((a, b) => Math.abs(a.at! - target) - Math.abs(b.at! - target));
    const post = candidates[0];
    if (!post) return;
    const t = post.targets.find((x) => x.ch.platform === platform && (!channel || x.ch === channel))!;
    t.attempts = [];
    let when = post.at! + between(3, 30) * 1000;
    for (let a = 1; a <= attempts; a++) {
      const last = a === attempts;
      t.attempts.push({ outcome: last ? (status === "needs_reauth" ? "needs_reauth" : "failed") : "retry", error, kind, at: when, ms: Math.round(between(900, 30_000)) });
      when += [60_000, 5 * MIN, 15 * MIN, HOUR][Math.min(a, 4) - 1];
    }
    t.status = status;
    t.publishedAt = null;
    t.error = error;
    t.errorKind = kind;
  };
  fail(3, "instagram", np, "Instagram rejected the media: the image's aspect ratio isn't supported for feed posts (use 4:5 to 1.91:1). Error code 36003.", "validation", 1, "failed", lIg);
  fail(9, "linkedin", np, "LinkedIn API: 504 Gateway Timeout. Gave up after 5 attempts.", "network", 5);
  fail(16, "x", np, "X API: 403 Forbidden — you are not allowed to create a post with duplicate content.", "validation", 1, "failed", aX);
  fail(6, "threads", maya, "Error validating access token: the session has been invalidated because the user changed their password.", "auth", 1, "needs_reauth", mTh);
  fail(24, "youtube", np, "YouTube: the channel has exceeded the number of videos it may upload (uploadLimitExceeded). Try again in 24 hours.", "quota", 5);
  fail(12, "mastodon", maya, "Mastodon: 503 Service Unavailable (art.example is under maintenance). Gave up after 5 attempts.", "network", 5);
  fail(33, "x", maya, "X API: 401 Unauthorized — the access token was revoked. Reconnected the same day.", "auth", 1, "failed", mX);

  // ── Evergreen recycling: originals with their recycled copies ──
  /** Evergreen originals published about `ages` days ago (so they were recycled a different number of times). */
  const recycle = (ws: number, intervalDays: number, max: number, ages: number[]) => {
    const originals = posts.filter((p) => p.ws === ws && p.source === "manual" && p.status === "published" && p.cap.evergreen && p.at! < NOW - (intervalDays + 2) * DAY && p.targets.every((t) => t.ch.status === "active"));
    const chosen: Post[] = [];
    const seen = new Set<string>();
    for (const age of ages) {
      const best = originals.filter((p) => !seen.has(p.cap.text)).sort((a, b) => Math.abs(a.at! - (NOW - age * DAY)) - Math.abs(b.at! - (NOW - age * DAY)))[0];
      if (!best) continue;
      seen.add(best.cap.text);
      chosen.push(best);
    }
    for (const original of chosen) {
      original.evergreen = true;
      let created = original.at! + intervalDays * DAY + between(0, 3) * HOUR;
      while (created < NOW && original.recycleCount < max) {
        const chs = original.targets.map((t) => t.ch);
        const slot = chs[0].slots.length ? chs[0].slots : slots(ALL_DAYS, ["12:00"]);
        // The next queue slot of the first channel after the copy was made.
        let when = created + HOUR;
        for (const day of localDays(created, chs[0].tz, 0, 8)) {
          const times = slot.filter((s) => s.day === day.weekday).map((s) => at(day, s.time, chs[0].tz)).filter((t) => t > created);
          if (times.length) {
            when = Math.min(...times);
            break;
          }
        }
        const copyCap: Cap = { ...original.cap, labels: original.cap.labels };
        const copy = addPost(ws, original.ownerId, copyCap, chs, when, when < NOW - 15 * MIN ? "published" : "scheduled", original.author, { source: "recycle", sourceRef: String(original.id) });
        copy.labels = original.labels;
        copy.createdAt = created;
        for (const t of copy.targets) {
          const prev = original.targets.find((x) => x.ch === t.ch);
          if (t.ch.platform === "x") t.override = { ...(prev?.override ?? {}), text: `${String(prev?.override.text ?? original.cap.text).trimEnd()} ♻${original.recycleCount ? ` ${original.recycleCount + 1}` : ""}` };
        }
        if (copy.status === "published") publish(copy);
        else schedule(copy);
        original.recycleCount += 1;
        original.lastRecycledAt = created;
        created += intervalDays * DAY + between(0, 3) * HOUR;
      }
    }
  };
  recycle(np, 21, 5, [84, 70, 55, 47, 34, 26]);
  recycle(maya, 30, 3, [86, 64, 41, 33]);

  // ── Upcoming: the next 14 days (queue slots), drafts, posts waiting for approval ──
  const UP_LUMEN: Cap[] = [
    { text: "Pumpkin-spice morning buns are back this week 🎃 Cream cheese frosting, toasted pepitas, warm at 8 am.", img: "lumen-autumn", firstComment: LUMEN_TAGS, labels: ["Autumn menu"] },
    { text: "Thanksgiving pie pre-orders close in one week 🥧 Pumpkin, apple-crumble and pecan. Pick-up the day before Thanksgiving.", img: "lumen-pie", link: "https://lumenandloaf.example/preorder", linkTitle: "Pie pre-orders", firstComment: LUMEN_TAGS, labels: ["Holidays"] },
    { text: "New this week: cardamom knots 🌀 Soft, buttery and just sweet enough. Warm out of the oven at 8 am.", img: "lumen-croissant", firstComment: LUMEN_TAGS },
    ...LUMEN_IMG,
    ...LUMEN_TEXT,
  ];
  const UP_ATLAS: Cap[] = [
    { text: "Trail Days start this weekend: 20% off packs, tents and sleep systems. Members shop a day early.", short: "Trail Days start this weekend: 20% off packs, tents and sleep systems 🏕️", img: "atlas-sale", link: "https://atlasoutdoor.example/trail-days", linkTitle: "Trail Days sale", labels: ["Trail Days"] },
    { text: "Daylight saving ends soon: pack a headlamp even on short afternoon hikes. Sunset comes faster than you think.", only: ["x"] },
    { text: "Free clinic on Saturday: we'll fit your pack and adjust your poles. No purchase needed.", short: "Free pack-fitting clinic on Saturday. No purchase needed 🎒", only: ["x", "linkedin"] },
    ...ATLAS_IMG,
    ...ATLAS_X,
  ];
  const UP_MAYA: Cap[] = [
    { text: "Palette Monday #43 is a community pick: you voted for autumn forest 🍂 Swatches go live at 10.", labels: ["Palette Monday"] },
    { text: "Grain & Glow launch week ends Sunday — last chance for the €9 price!", img: "maya-brushes", link: "https://mayacreates.example/shop/grain-glow", linkTitle: "Grain & Glow brush pack", labels: ["Grain & Glow"] },
    { text: "Live drawing stream on Thursday at 7 pm CET! Bring a prompt and I'll sketch it live 🎨", img: "maya-live", link: "https://mayacreates.example/live", linkTitle: "Live drawing stream", labels: ["Live"] },
    ...MAYA_TEXT.filter((c) => !c.thread).flatMap((c, k) => [c, { text: MAYA_TIPS[k % MAYA_TIPS.length] }]),
  ];
  const upcoming = (brand: Brand, pool: Cap[], specials: number, p: number, author: () => number) => {
    let i = 0;
    let imageTurn = 0;
    const used = new Set<Cap>();
    for (const day of localDays(NOW, brand.tz, 0, 14)) {
      const times = [...new Set(brand.channels.flatMap((c) => c.slots.filter((s) => s.day === day.weekday).map((s) => s.time)))].sort();
      for (const time of times) {
        const special = brand.channels.some((c) => (c.platform === "linkedin" || c.platform === "youtube") && c.slots.some((s) => s.day === day.weekday && s.time === time));
        if (!chance(special ? 0.85 : p)) continue;
        const queueMode = chance(0.7);
        const when = queueMode ? at(day, time, brand.tz) : at(day, time, brand.tz) + Math.round(between(-2, 3)) * 15 * MIN + 10 * MIN;
        if (when < NOW + 20 * MIN) continue;
        // Channels with this slot that may still publish then (LinkedIn's token runs out in 5 days).
        let chs = brand.channels.filter((c) => c.status === "active" && c.slots.some((s) => s.day === day.weekday && s.time === time) && !(c.platform === "linkedin" && when > NOW + 4.5 * DAY));
        if (!chs.length) continue;
        // The first caption (round robin) that suits every channel of the slot, else the one that suits most.
        const suits = (cap: Cap) => chs.filter((c) => (!cap.only || cap.only.includes(c.platform)) && (c.platform !== "instagram" || Boolean(cap.img)) && (c.platform !== "youtube" || Boolean(cap.video)) && !clashes(cap, c, when));
        const options = chs.some((c) => c.platform === "youtube") ? ATLAS_VIDEO : pool;
        // Launch / seasonal captions (the first ones of the pool) are used once.
        const fresh = (c: Cap) => !(pool.indexOf(c) > -1 && pool.indexOf(c) < specials && used.has(c));
        // Slots with Instagram take the image captions in turn; the others the whole pool in turn.
        const needsImage = chs.some((c) => c.platform === "instagram");
        const fitting = options.filter((c) => fresh(c) && (!needsImage || c.img) && suits(c).length);
        // Captions not queued yet in these two weeks first, so the calendar doesn't repeat itself.
        const unqueued = fitting.filter((c) => !used.has(c));
        const list = unqueued.length ? unqueued : fitting;
        if (!list.length) continue;
        const n = needsImage ? imageTurn++ : i;
        let cap = list[n % list.length];
        let best = suits(cap);
        for (let k = 1; k < list.length && best.length < chs.length; k++) {
          const candidate = list[(n + k) % list.length];
          const ok = suits(candidate);
          if (ok.length > best.length) {
            cap = candidate;
            best = ok;
          }
        }
        i += 1;
        used.add(cap);
        chs = best;
        if (!chs.length) continue;
        const who = author();
        const post = addPost(brand.ws, adminId, cap, chs, when, "scheduled", who);
        approve(post);
        schedule(post);
      }
    }
  };
  upcoming(lumen, UP_LUMEN, 3, 0.5, () => (chance(editorShare(np)) ? editorId : adminId));
  upcoming(atlas, UP_ATLAS, 3, 0.32, () => (chance(editorShare(np)) ? editorId : adminId));
  upcoming(mayaBrand, UP_MAYA, 3, 0.62, () => adminId);

  // Queued from the Atlas journal feed (next common slot of X and LinkedIn).
  {
    const itemId = id("rss_items");
    const link = "https://atlasoutdoor.example/journal/first-snow-checklist";
    const title = "First-snow checklist: 9 things to pack for November hikes";
    const day = localDays(NOW, NY, 1, 1)[0];
    const when = at(day, "13:00", NY) > NOW ? at(day, "13:00", NY) : NOW + DAY;
    const post = addPost(np, adminId, { text: `${title}\n\n${link}\n\n#hiking`, link }, [aX], when, "scheduled", adminId, { source: "rss", sourceRef: String(itemId) });
    post.createdAt = NOW - 3 * HOUR;
    schedule(post);
    rows.rss_items.push({ id: itemId, feed_id: feedNp, guid_hash: sha256(link), guid: link, url: link, title, published_at: iso(NOW - 4 * HOUR), post_id: post.id, created_at: iso(NOW - 3 * HOUR) });
  }

  // Drafts.
  addPost(np, adminId, { text: "Gift cards are here! 🎁 The easiest present for anyone who loves bread. Available in store and online from $15.", link: "https://lumenandloaf.example/gift-cards", linkTitle: "Gift cards" }, [lFb, lTh], at(localDays(NOW, NY, 9, 9)[0], "12:30", NY), "draft", editorId);
  addPost(np, adminId, { text: "Draft: winter traction guide — microspikes vs. crampons vs. snowshoes. Need photos from the gear team.", short: "Microspikes, crampons or snowshoes? Our winter traction guide drops next week ❄️" }, [aX, aLi], null, "draft", adminId);
  addPost(maya, adminId, { text: "Idea: a 7-day colour challenge in December. One palette a day, everyone posts with #MayaPalettes. Too much?" }, [mBs, mMa], null, "draft", adminId);

  // Posts waiting for approval (Lumen & Loaf, written by the editor) — one with a discussion.
  const pendingDays = localDays(NOW, NY, 3, 6);
  const pending1 = addPost(
    np,
    adminId,
    { text: "Meet our new seasonal loaf: cranberry, walnut and a little orange zest 🍊 Perfect for the holiday table. Available Fridays and Saturdays from next week.", img: "lumen-sourdough", firstComment: LUMEN_TAGS },
    [lIg, lFb, lTh],
    at(pendingDays[0], "08:00", NY),
    "pending_approval",
    editorId,
  );
  const pending2 = addPost(np, adminId, { text: "Our Sunday bread workshop has 3 seats left for this month! Starters, shaping, scoring — and you take two loaves home 👩‍🍳", img: "lumen-workshop", link: "https://lumenandloaf.example/workshops", linkTitle: "Bread workshops", firstComment: LUMEN_TAGS }, [lIg, lFb], at(pendingDays[Math.min(2, pendingDays.length - 1)], "12:30", NY), "pending_approval", editorId);
  for (const p of [pending1, pending2]) p.createdAt = NOW - between(5, 20) * HOUR;
  const comment = (post: Post, user: number | null, author: string, kind: Row<"post_comments">["kind"], body: string, ms: number) =>
    rows.post_comments.push({ id: id("post_comments"), post_id: post.id, workspace_id: post.ws, user_id: user, author_name: author, kind, body, created_at: iso(ms) });
  comment(pending1, approverId, nameOf.get(approverId) ?? "Approver", "note", "Love this one! Could we use the croissant photo instead? The bread shot already ran on Saturday.", pending1.createdAt + 2 * HOUR);
  comment(pending1, editorId, nameOf.get(editorId) ?? "Editor", "note", "Good call. I'll wait for the client's photo of the actual loaf — they're shooting it on Thursday.", pending1.createdAt + 3 * HOUR);
  comment(pending1, null, "Lena (Lumen & Loaf)", "note", "Photos are coming Thursday afternoon! Text looks perfect 👍", pending1.createdAt + 5 * HOUR);
  // Decisions on earlier editor posts.
  posts
    .filter((p) => p.approvedBy && p.status !== "scheduled")
    .slice(-6)
    .forEach((p, i) => comment(p, approverId, nameOf.get(approverId) ?? "Approver", "approved", ["Looks great!", "", "Approved — nice caption.", "", "Good to go 👍", ""][i], p.approvedAt!));

  // ── Customers: a small workspace each ──
  const CUSTOMERS: Array<{ name: string; tz: string; avatar: string; chans: Array<[Platform, string, string, number]>; texts: string[] }> = [
    {
      name: "Kite & Key Bookshop",
      tz: "Europe/London",
      avatar: "kiteandkey",
      chans: [["facebook", "Kite & Key Bookshop", "", 3_400], ["mastodon", "Kite & Key Books", "@kiteandkey@books.example", 1_100]],
      texts: ["Staff pick of the week: a quiet, devastating novel about a lighthouse family. Ask Priya at the till!", "Author signing on Saturday at 3 pm — bring your copy or buy one on the day.", "New shelf alert: translated fiction from 12 countries.", "Book club meets Thursday at 7. This month: short stories, so no excuses 📚", "Rainy Sunday reading list, chosen by our team.", "We're open late on Fridays until Christmas."],
    },
    {
      name: "Oakline Fitness",
      tz: "America/Chicago",
      avatar: "oakline",
      chans: [["threads", "Oakline Fitness", "@oaklinefit", 5_200], ["bluesky", "Oakline Fitness", "@oaklinefit.bsky.social", 900]],
      texts: ["6 am HIIT is back on Tuesdays and Thursdays 💪", "Member spotlight: Dana ran her first half marathon this weekend!", "Mobility tip: 5 minutes of hip openers before every squat session.", "New spin bikes arrive next week. The old ones go to the community centre.", "Holiday schedule: open 8 am – 2 pm on public holidays.", "Bring a friend for free every Friday this month."],
    },
    {
      name: "Saltwater Ceramics",
      tz: "Australia/Sydney",
      avatar: "saltwater",
      chans: [["mastodon", "Saltwater Ceramics", "@saltwater@makers.example", 1_700], ["telegram", "Saltwater Ceramics", "@saltwaterceramics", 640]],
      texts: ["Kiln opening on Sunday! Speckled mugs, ocean-glaze bowls and a few seconds at a discount.", "Wheel-throwing classes for beginners: four Saturdays, all clay included.", "Glaze test results are in. The sea-foam blue is staying 🌊", "Studio closed next Monday for a firing.", "New collection: tide-pool plates, each one unique.", "Thank you for 1,000 orders! Free shipping this weekend."],
    },
  ];
  const customerWs: number[] = [];
  customers.forEach((user, ci) => {
    const def = CUSTOMERS[ci];
    const ws = id("workspaces");
    customerWs.push(ws);
    rows.workspaces.push({ id: ws, owner_id: user.id, name: def.name, timezone: def.tz, settings: JSON.stringify({ approvalRequired: false, defaultSlots: slots(WEEKDAYS, ["09:00", "17:00"]), weekStart: 1, utm: { enabled: false, source: "{platform}", medium: "social", campaign: "" }, shortenLinks: false, branding: { companyName: "", logo: "", color: "" } }), is_personal: 1, recycle_settings: null, created_at: iso(NOW - (70 - ci * 9) * DAY), updated_at: iso(NOW - ci * DAY) });
    member(ws, user.id, "owner", 70 - ci * 9);
    const chs = def.chans.map(([platform, name, handle, followers]) => addChannel(ws, `cust${ci}-${platform}`, platform, name, handle, def.avatar, followers, def.tz, slots(WEEKDAYS, ["09:00", "17:00"]), { created: NOW - (65 - ci * 9) * DAY }));
    let k = 0;
    for (const day of localDays(NOW, def.tz, -60 + ci * 9, 9)) {
      if (day.offset % 6 !== 0 && day.offset !== 2 && day.offset !== 5) continue;
      const when = at(day, day.offset % 12 === 0 ? "09:00" : "17:00", def.tz);
      if (Math.abs(when - NOW) < 30 * MIN) continue;
      const text = def.texts[k++ % def.texts.length];
      const post = addPost(ws, user.id, { text }, chs, when, when < NOW ? "published" : "scheduled", user.id);
      if (when < NOW) publish(post);
      else schedule(post);
    }
  });

  // ── Finalise posts and targets: ids, statuses, attempts, metrics, usage ──
  const usage = new Map<string, { user: number; month: string; posts: number; x: number }>();
  const platformDay = new Map<string, Row<"platform_usage_daily">>();
  const bumpDay = (platform: Platform, ms: number, delta: { posts?: number; uploads?: number; errors?: number; api?: number; cost?: number }) => {
    const day = iso(ms).slice(0, 10);
    const key = `${platform}|${day}`;
    const row = platformDay.get(key) ?? { platform, day, posts: 0, uploads: 0, api_calls: 0, errors: 0, cost_micros: 0 };
    row.posts = Number(row.posts) + (delta.posts ?? 0);
    row.uploads = Number(row.uploads) + (delta.uploads ?? 0);
    row.errors = Number(row.errors) + (delta.errors ?? 0);
    row.api_calls = Number(row.api_calls) + (delta.api ?? 0);
    row.cost_micros = Number(row.cost_micros) + (delta.cost ?? 0);
    platformDay.set(key, row);
  };
  const failedTargets: Array<{ post: Post; t: Tgt }> = [];
  for (const post of posts) {
    if (post.status === "published") {
      const statuses = post.targets.map((t) => t.status);
      post.status = aggregatePostStatus(statuses) as Post["status"];
      const done = post.targets.flatMap((t) => [t.publishedAt ?? 0, ...t.attempts.map((a) => a.at + a.ms)]);
      post.publishedAt = Math.max(...done);
    }
    for (const t of post.targets) {
      const caps = PLATFORM_CAPABILITIES[t.ch.platform];
      if (t.status === "published" || t.status === "failed" || t.status === "needs_reauth") t.quotaMonth = month(post.createdAt);
      if (t.quotaMonth) {
        const key = `${post.ownerId}|${t.quotaMonth}`;
        const u = usage.get(key) ?? { user: post.ownerId, month: t.quotaMonth, posts: 0, x: 0 };
        u.posts += 1;
        if (t.ch.platform === "x") u.x += 1;
        usage.set(key, u);
      }
      if (t.status === "published") {
        t.extId = `${t.ch.platform}-${t.id}-${simHash(`${t.id}:${post.id}`).toString(36)}`;
        const content = JSON.parse(post.content) as { thread: string[]; firstComment: string; link: string; text: string };
        const merged = { ...content, ...t.override } as typeof content;
        const threadParts = caps.threads.supported ? merged.thread.filter((p) => p.trim()).length : 0;
        const comment = merged.firstComment.trim() && caps.firstComment !== "none" ? 1 : 0;
        const parts = 1 + threadParts + comment;
        const withUrl = Boolean(merged.link || /https?:\/\//.test(merged.text));
        bumpDay(t.ch.platform, t.publishedAt!, { posts: parts, uploads: t.ch.platform === "youtube" ? 1 : 0, cost: caps.cost ? Math.round((withUrl ? caps.cost.perPostWithUrl : caps.cost.perPost) * 1_000_000) * (1 + threadParts) : 0 });
      }
      for (const a of t.attempts) if (a.outcome !== "published") bumpDay(t.ch.platform, a.at, { errors: 1 });
      if (t.status === "failed" || t.status === "needs_reauth") failedTargets.push({ post, t });
    }
  }
  // Metrics API calls per channel and day (the metrics job asks about once a day per channel).
  for (const ch of channels) {
    if (!PLATFORM_CAPABILITIES[ch.platform].analytics.supported) continue;
    for (let d = 0; d < 90; d++) bumpDay(ch.platform, NOW - d * DAY, { api: d === 0 ? 1 : 1 + (d % 3 === 0 ? 1 : 0) });
  }

  const audienceOf = new Map(channels.map((c) => [c.id, simAudience({ followers: c.followers, audienceTz: c.tz, audienceSince: since })]));
  for (const post of posts) {
    rows.posts.push({
      id: post.id,
      workspace_id: post.ws,
      author_id: post.author,
      status: post.status,
      scheduled_at: post.at ? iso(post.at) : null,
      content: post.content,
      labels: JSON.stringify(post.labels),
      source: post.source,
      source_ref: post.sourceRef,
      is_evergreen: post.evergreen ? 1 : 0,
      recycle_count: post.recycleCount,
      last_recycled_at: post.lastRecycledAt ? iso(post.lastRecycledAt) : null,
      approved_by: post.approvedBy,
      approved_at: post.approvedAt ? iso(post.approvedAt) : null,
      published_at: post.publishedAt ? iso(post.publishedAt) : null,
      created_at: iso(post.createdAt),
      updated_at: iso(post.publishedAt ?? Math.max(post.createdAt, ...(post.status === "pending_approval" ? [post.createdAt + 5 * HOUR] : []))),
    });
    for (const t of post.targets) {
      const scheduled = post.status !== "draft" && post.status !== "pending_approval" && post.at;
      const last = t.attempts[t.attempts.length - 1];
      const permalink = t.extId ? `https://example.social/${t.ch.platform}/${(t.ch.handle || t.ch.name).replace(/^[@#]/, "").replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}/${t.extId}` : null;
      const content = JSON.parse(post.content) as { thread: string[]; firstComment: string };
      const caps = PLATFORM_CAPABILITIES[t.ch.platform];
      const threadIds = t.extId && caps.threads.supported ? content.thread.map((_, i) => `${t.extId}-t${i + 1}`) : [];
      const firstCommentId = t.extId && content.firstComment && caps.firstComment !== "none" && t.override.firstComment !== "" ? `${t.extId}-c` : null;
      rows.post_targets.push({
        id: t.id,
        post_id: post.id,
        workspace_id: post.ws,
        channel_id: t.ch.id,
        platform: t.ch.platform,
        override: JSON.stringify(t.override),
        status: t.status,
        scheduled_at: scheduled ? iso(post.at!) : null,
        next_attempt_at: t.status === "scheduled" ? iso(post.at!) : null,
        attempts: t.attempts.length,
        lease_until: null,
        lease_token: null,
        external_id: t.extId,
        container_id: null,
        upload_state: t.extId ? JSON.stringify({ published: { id: t.extId, threadIds, firstCommentId } }) : "{}",
        permalink,
        published_at: t.publishedAt ? iso(t.publishedAt) : null,
        error: t.error,
        error_kind: t.errorKind,
        quota_month: t.quotaMonth,
        created_at: iso(post.createdAt),
        updated_at: iso(t.publishedAt ?? (last ? last.at + last.ms : post.createdAt)),
      });
      t.attempts.forEach((a, i) =>
        rows.post_attempts.push({ id: id("post_attempts"), target_id: t.id, post_id: post.id, workspace_id: post.ws, channel_id: t.ch.id, attempt: i + 1, outcome: a.outcome, error: a.error, error_kind: a.kind, started_at: iso(a.at), duration_ms: a.ms }),
      );
      if (t.status === "published" && caps.analytics.supported) {
        const m = simMetrics(t.ch.platform, t.extId!, iso(t.publishedAt!), NOW, audienceOf.get(t.ch.id));
        const age = NOW - t.publishedAt!;
        const fetched = age > 30 * DAY ? t.publishedAt! + 30 * DAY - between(1, 20) * HOUR : age < DAY ? NOW - between(5, 50) * MIN : NOW - between(1, 20) * HOUR;
        rows.post_metrics.push({ id: id("post_metrics"), target_id: t.id, post_id: post.id, channel_id: t.ch.id, workspace_id: post.ws, fetched_at: iso(fetched), views: m.views ?? null, impressions: m.impressions ?? null, reach: m.reach ?? null, likes: m.likes ?? null, comments: m.comments ?? null, shares: m.shares ?? null, saves: m.saves ?? null, clicks: m.clicks ?? null, quotes: m.quotes ?? null });
      }
    }
  }

  // ── Short links with daily clicks ──
  const CODE = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes = new Set<string>();
  const code = () => {
    let c = "";
    do c = Array.from({ length: 7 }, () => CODE[Math.floor(r() * CODE.length)]).join("");
    while (codes.has(c));
    codes.add(c);
    return c;
  };
  const addLink = (ws: number, title: string, baseUrl: string, utm: { source: string; medium: string; campaign: string }, postId: number | null, channelId: number | null, createdMs: number, peak: number, steady: number) => {
    const lid = id("short_links");
    let total = 0;
    let lastDay = "";
    for (let d = 0; createdMs + d * DAY < NOW; d++) {
      const ms = createdMs + d * DAY;
      const weekday = new Date(ms).getUTCDay();
      const clicks = Math.round((peak * Math.exp(-d / 3.2) + steady * between(0.4, 1.4)) * (weekday === 0 || weekday === 6 ? 0.7 : 1));
      if (clicks <= 0) continue;
      const day = iso(ms).slice(0, 10);
      rows.link_clicks_daily.push({ link_id: lid, day, clicks });
      total += clicks;
      lastDay = day;
    }
    rows.short_links.push({ id: lid, workspace_id: ws, code: code(), title, url: buildUtmUrl(baseUrl, utm), utm: JSON.stringify({ ...utm, term: "", content: "", base: baseUrl }), post_id: postId, channel_id: channelId, clicks: total, last_clicked_at: lastDay ? `${lastDay}T${String(Math.floor(between(8, 22))).padStart(2, "0")}:${String(Math.floor(between(0, 59))).padStart(2, "0")}:00.000Z` : null, created_at: iso(createdMs) });
  };
  posts
    .filter((p) => p.ws === np && p.cap.link && p.source !== "rss" && p.publishedAt && p.publishedAt > NOW - 60 * DAY && p.targets.some((t) => t.status === "published"))
    .slice(-28)
    .forEach((p) => {
      const t = p.targets.find((x) => x.status === "published")!;
      addLink(np, p.cap.linkTitle ?? "", p.cap.link!, { source: t.ch.platform, medium: "social", campaign: "northpeak" }, p.id, t.ch.id, p.at! - 2 * MIN, (t.ch.followers / 1000) * between(1.5, 4), between(0.5, 3));
    });
  for (const [title, path, days, peak, steady] of [
    ["Shop: Grain & Glow", "shop/grain-glow", 24, 160, 9],
    ["Newsletter sign-up", "newsletter", 80, 40, 6],
    ["Commissions", "commissions", 45, 55, 3],
    ["Free palettes", "palettes", 70, 30, 7],
    ["Live stream", "live", 12, 70, 2],
    ["Portfolio", "portfolio", 88, 15, 4],
  ] as Array<[string, string, number, number, number]>) {
    addLink(maya, title, `https://mayacreates.example/${path}`, { source: "social", medium: "bio", campaign: "maya" }, null, null, NOW - days * DAY, peak, steady);
  }

  // ── Automation: RSS feeds ──
  const atlasItems = rows.rss_items.filter((i) => i.feed_id === feedNp);
  const mayaItems = rows.rss_items.filter((i) => i.feed_id === feedMaya);
  rows.rss_feeds.push(
    {
      id: feedNp,
      workspace_id: np,
      url: "https://atlasoutdoor.example/journal/feed.xml",
      title: "Atlas Outdoor Journal",
      channel_ids: JSON.stringify([aX.id, aLi.id]),
      template: "{title}\n\n{link}",
      mode: "queue",
      ai_rewrite: 0,
      interval_minutes: 60,
      status: "active",
      last_checked_at: iso(NOW - 22 * MIN),
      next_check_at: iso(NOW + 38 * MIN),
      etag: '"a7c3-journal"',
      last_modified: new Date(NOW - 4 * HOUR).toUTCString(),
      last_error: null,
      options: JSON.stringify({ maxItems: 3, backfill: false, utm: { enabled: true, source: "{platform}", medium: "rss", campaign: "journal" }, shortenLinks: true, hashtags: "#hiking" }),
      items_posted: atlasItems.filter((i) => i.post_id).length,
      created_by: adminId,
      created_at: iso(NOW - 88 * DAY),
      updated_at: iso(NOW - 22 * MIN),
    },
    {
      id: feedMaya,
      workspace_id: maya,
      url: "https://mayacreates.example/blog/rss",
      title: "Maya's studio blog",
      channel_ids: JSON.stringify([mBs.id, mMa.id, mTg.id]),
      template: "{title}\n\n{link}",
      mode: "publish",
      ai_rewrite: 0,
      interval_minutes: 120,
      status: "active",
      last_checked_at: iso(NOW - 47 * MIN),
      next_check_at: iso(NOW + 73 * MIN),
      etag: null,
      last_modified: new Date(NOW - 2 * DAY).toUTCString(),
      last_error: null,
      options: JSON.stringify({ maxItems: 2, backfill: false, utm: { enabled: false, source: "{platform}", medium: "social", campaign: "" }, shortenLinks: false, hashtags: "" }),
      items_posted: mayaItems.filter((i) => i.post_id).length,
      created_by: adminId,
      created_at: iso(NOW - 85 * DAY),
      updated_at: iso(NOW - 47 * MIN),
    },
  );

  // ── Client approval link (Lumen & Loaf, next week) ──
  const token = crypto.randomBytes(24).toString("base64url");
  const linkPosts = posts.filter((p) => p.ws === np && p.at && p.at > NOW && p.at < NOW + 8 * DAY && p.targets.some((t) => t.ch.key.startsWith("lumen")) && (p.status === "scheduled" || p.status === "pending_approval")).map((p) => p.id);
  rows.approval_links.push(
    { id: id("approval_links"), workspace_id: np, token_hash: sha256(crypto.randomBytes(24).toString("base64url")), post_ids: null, range_from: iso(NOW - 40 * DAY), range_to: iso(NOW - 26 * DAY), password_hash: null, label: "Atlas Outdoor · Trail Days campaign", created_by: adminId, expires_at: iso(NOW - 12 * DAY), revoked_at: null, last_viewed_at: iso(NOW - 30 * DAY), created_at: iso(NOW - 42 * DAY) },
    { id: id("approval_links"), workspace_id: np, token_hash: sha256(token), post_ids: JSON.stringify(linkPosts.sort((a, b) => a - b)), range_from: null, range_to: null, password_hash: null, label: "Lumen & Loaf · next week", created_by: adminId, expires_at: iso(NOW + 14 * DAY), revoked_at: null, last_viewed_at: iso(NOW - 3 * HOUR), created_at: iso(NOW - DAY) },
  );

  // ── API key, notification channels and their log ──
  rows.api_keys.push({ id: id("api_keys"), workspace_id: np, user_id: adminId, name: "Zapier — Shopify product launches", key_hash: sha256(crypto.randomBytes(32).toString("hex")), prefix: `qz_${crypto.randomBytes(5).toString("hex").slice(0, 7)}`, last_used_at: iso(NOW - 3 * HOUR), created_at: iso(NOW - 60 * DAY) });
  const events = ["post_failed", "approval_requested", "approval_decided", "channel_expiring", "channel_disconnected", "rss_failed", "quota_warning", "quota_reached"];
  const notifyNp = id("notify_channels");
  const notifyMaya = id("notify_channels");
  rows.notify_channels.push(
    { id: notifyNp, workspace_id: np, created_by: adminId, type: "email", name: "Northpeak alerts", config: JSON.stringify({ to: "alerts@northpeak.example" }), events: JSON.stringify(events), is_active: 1, created_at: iso(NOW - 100 * DAY), updated_at: iso(NOW - 100 * DAY) },
    { id: notifyMaya, workspace_id: maya, created_by: adminId, type: "email", name: "Studio inbox", config: JSON.stringify({ to: "maya@mayacreates.example" }), events: JSON.stringify(["post_failed", "channel_expiring", "channel_disconnected", "rss_failed"]), is_active: 1, created_at: iso(NOW - 90 * DAY), updated_at: iso(NOW - 90 * DAY) },
  );
  const alert = (ws: number, channelId: number, event: string, ms: number, postId: number | null = null) => rows.alert_log.push({ id: id("alert_log"), workspace_id: ws, post_id: postId, channel_id: channelId, event, ok: 1, error: null, created_at: iso(ms) });
  for (const { post, t } of failedTargets) {
    if (post.at! < NOW - 85 * DAY) continue;
    const last = t.attempts[t.attempts.length - 1];
    alert(post.ws, post.ws === np ? notifyNp : notifyMaya, t.status === "needs_reauth" ? "channel_disconnected" : "post_failed", last.at + last.ms + 2000, post.id);
  }
  for (const p of posts.filter((x) => x.approvedBy && x.approvedAt! > NOW - 21 * DAY)) {
    alert(np, notifyNp, "approval_requested", p.createdAt + 60_000, p.id);
    alert(np, notifyNp, "approval_decided", p.approvedAt!, p.id);
  }
  alert(np, notifyNp, "approval_requested", pending1.createdAt + 60_000, pending1.id);
  alert(np, notifyNp, "approval_requested", pending2.createdAt + 60_000, pending2.id);
  alert(np, notifyNp, "channel_expiring", NOW - 2 * DAY - 2 * HOUR);
  rows.alert_log.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const firstAlert = Math.min(...rows.alert_log.map((row) => Number(row.id)));
  rows.alert_log.forEach((row, i) => (row.id = firstAlert + i));

  // ── Usage meters ──
  for (const u of usage.values()) {
    const current = u.month === month(NOW);
    rows.usage_monthly.push({ user_id: u.user, month: u.month, posts_scheduled: u.posts, x_posts: u.x, ai_requests: u.user === adminId ? (current ? 37 : 52) : current ? 4 : 0, quota_alerts: null });
  }
  rows.platform_usage_daily.push(...[...platformDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.platform).localeCompare(String(b.platform))));

  // ── Write ──
  const counts: Record<string, number> = {};
  for (const [table, list] of Object.entries(rows) as Array<[keyof typeof rows, Array<Record<string, unknown>>]>) {
    counts[table] = list.length;
    for (let i = 0; i < list.length; i += 400) {
      await trx
        .insertInto(table)
        .values(list.slice(i, i + 400) as never)
        .execute();
    }
  }
  // The raw token of the showcase approval link (the landing page links to it).
  const exists = await trx.selectFrom("settings").select("key").where("key", "=", "showcase_approval_token").executeTakeFirst();
  if (exists) await trx.updateTable("settings").set({ value: token }).where("key", "=", "showcase_approval_token").execute();
  else await trx.insertInto("settings").values({ key: "showcase_approval_token", value: token }).execute();
  counts.customer_workspaces = customerWs.length;
  return counts;
}
