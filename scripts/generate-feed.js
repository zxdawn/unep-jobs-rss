import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// ---- CONFIG ----------------------------------------------------------
const JOB_LIST_URL =
  "https://careers.un.org/jobopening?data=%7B%22dept%22%3A%5B%2222302230%22%5D%7D";
const FEED_TITLE = "UN Careers — Department 22302230";
const FEED_LINK = JOB_LIST_URL;
const FEED_DESCRIPTION = "Auto-generated RSS feed of UN job openings filtered by department 22302230";
const OUTPUT_PATH = path.join("docs", "feed.xml");
const MAX_ITEMS = 100;
// -----------------------------------------------------------------------

function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function scrapeJobs() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  });

  await page.goto(JOB_LIST_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Wait for at least one job link to render. The site links to
  // individual postings via an href containing "/jobopening/<id>".
  try {
    await page.waitForSelector('a[href*="/jobopening/"]', { timeout: 30000 });
  } catch {
    // No jobs matched, or selectors changed — fall through with empty list.
  }

  // Give the SPA a little extra time to finish painting list items.
  await page.waitForTimeout(2000);

  const jobs = await page.evaluate(() => {
    const seen = new Map();
    const anchors = Array.from(
      document.querySelectorAll('a[href*="/jobopening/"]')
    );

    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/\/jobopening\/(\d+)/);
      if (!match) continue; // skip the generic listing link itself
      const id = match[1];
      if (seen.has(id)) continue;

      // Try to find a good title: the link's own text, or a heading
      // inside the same card/container.
      let title = (a.textContent || "").trim();
      if (!title || title.length < 3) {
        const card = a.closest("li, article, div");
        const heading = card && card.querySelector("h1,h2,h3,h4,strong");
        if (heading) title = heading.textContent.trim();
      }
      if (!title) title = `Job opening ${id}`;

      // Try to grab surrounding card text for a short description
      // (department, grade, duty station, deadline etc. often sit nearby).
      const card = a.closest("li, article, div");
      let context = "";
      if (card) {
        context = card.textContent.replace(/\s+/g, " ").trim().slice(0, 500);
      }

      const absoluteUrl = href.startsWith("http")
        ? href
        : new URL(href, "https://careers.un.org").toString();

      seen.set(id, { id, title, url: absoluteUrl, context });
    }

    return Array.from(seen.values());
  });

  await browser.close();
  return jobs;
}

function buildRss(jobs) {
  const now = new Date().toUTCString();
  const items = jobs
    .slice(0, MAX_ITEMS)
    .map((job) => {
      return `    <item>
      <title>${escapeXml(job.title)}</title>
      <link>${escapeXml(job.url)}</link>
      <guid isPermaLink="false">un-careers-${escapeXml(job.id)}</guid>
      <pubDate>${now}</pubDate>
      <description>${escapeXml(job.context)}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${escapeXml(FEED_LINK)}</link>
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

async function main() {
  const jobs = await scrapeJobs();
  console.log(`Scraped ${jobs.length} job openings.`);

  if (jobs.length === 0) {
    console.warn(
      "WARNING: 0 jobs found. The page's markup may have changed, or the department has no open postings. Feed will still be written (possibly empty) — check the Action logs."
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, buildRss(jobs), "utf8");
  console.log(`Wrote feed to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
