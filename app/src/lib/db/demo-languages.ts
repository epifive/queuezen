import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "./schema";
import { acquireSeedLock, finishSeedLock, releaseSeedLock } from "./seed-lock";

/** Translations of the default site texts, so the demo's home page is fully translated. */
const SITE_TEXTS: Record<string, Record<string, string>> = {
  ar: {
    "setting.site_tagline": "خطّط لمنشوراتك واحصل على الموافقة عليها وانشرها في كل مكان",
    "setting.home_hero_title": "خطّط مرة واحدة. انشر في كل مكان. في الوقت المناسب.",
    "setting.home_hero_subtitle":
      "اكتب المنشور مرة واحدة، وكيّفه لكل شبكة، واحصل على الموافقة عليه، ودع قائمة الانتظار تنشره في الوقت المناسب، مع التعليق الأول والسلاسل والتحليلات المدمجة.",
    "setting.footer_text": "جدولة منشورات وسائل التواصل الاجتماعي والموافقات والتحليلات لصنّاع المحتوى والفرق والوكالات.",
    "setting.copyright_text": "© {year} {site_name}. جميع الحقوق محفوظة.",
    "setting.cookie_consent_text": "نستخدم ملفات تعريف الارتباط لإبقائك مسجلًا الدخول ولفهم كيفية استخدام الموقع. باستمرارك في التصفح فإنك توافق على استخدامنا لها.",
  },
  hi: {
    "setting.site_tagline": "सोशल पोस्ट प्लान करें, अप्रूवल लें और हर जगह पब्लिश करें",
    "setting.home_hero_title": "एक बार प्लान करें। हर जगह पब्लिश करें। सही समय पर।",
    "setting.home_hero_subtitle":
      "पोस्ट एक बार लिखें, हर नेटवर्क के लिए ढालें, अप्रूवल लें और क्यू को सही समय पर पब्लिश करने दें। पहला कमेंट, थ्रेड और एनालिटिक्स पहले से शामिल हैं।",
    "setting.footer_text": "क्रिएटर्स, टीमों और एजेंसियों के लिए सोशल मीडिया शेड्यूलिंग, अप्रूवल और एनालिटिक्स।",
    "setting.copyright_text": "© {year} {site_name}. सर्वाधिकार सुरक्षित।",
    "setting.cookie_consent_text": "हम आपको साइन इन रखने और साइट के इस्तेमाल को समझने के लिए कुकी का इस्तेमाल करते हैं। आगे बढ़कर आप कुकी के इस्तेमाल से सहमत होते हैं।",
  },
};

interface LanguagePack {
  language: { code: string; name: string; native_name: string; direction: "ltr" | "rtl" };
  translations: Record<string, string>;
}

/** Install the bundled Hindi and Arabic packs on a demo site (once, guarded by a settings row). */
export async function seedDemoLanguages(db: Kysely<Database>): Promise<void> {
  const lock = await acquireSeedLock(db, "demo_languages_seeded_at");
  if (!lock) return;
  try {
    await installPacks(db);
  } catch (err) {
    await releaseSeedLock(db, lock);
    throw err;
  }
  await finishSeedLock(db, lock);
}

async function installPacks(db: Kysely<Database>): Promise<void> {
  const packs = [(await import("../../../languages/hi.json")).default, (await import("../../../languages/ar.json")).default] as LanguagePack[];
  for (const [index, pack] of packs.entries()) {
    const { code, name, native_name, direction } = pack.language;
    const exists = await db.selectFrom("languages").select("code").where("code", "=", code).executeTakeFirst();
    if (exists) continue;
    const rows = Object.entries({ ...pack.translations, ...SITE_TEXTS[code] }).map(([key, value]) => ({ lang: code, key, value }));
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("languages").values({ code, name, native_name, direction, is_active: 1, sort_order: (index + 1) * 10 }).execute();
      for (let i = 0; i < rows.length; i += 200) await trx.insertInto("translations").values(rows.slice(i, i + 200)).execute();
    });
  }
}
