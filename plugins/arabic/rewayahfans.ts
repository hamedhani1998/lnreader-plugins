import { load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';

type WPPage = {
  title: { rendered: string };
  slug: string;
  date: string;
  content?: { rendered: string };
  _embedded?: {
    'wp:featuredmedia'?: { source_url: string }[];
  };
};

class RewayahFans implements Plugin.PluginBase {
  id = 'rewayahfans';
  name = 'روايه فانز';
  version = '1.0.0';
  icon = 'src/ar/rewayahfans/icon.png';
  site = 'https://rewayahfans.net/';

  private allNovels: Plugin.NovelItem[] = [];

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetchApi(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async fetchHtml(url: string): Promise<string> {
    const res = await fetchApi(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.text();
  }

  private async loadAllNovels(): Promise<Plugin.NovelItem[]> {
    if (this.allNovels.length > 0) return this.allNovels;

    const html = await this.fetchHtml(
      `${this.site}%d9%82%d8%a7%d8%a6%d9%85%d8%a9-%d8%a7%d9%84%d8%b1%d9%88%d8%a7%d9%8a%d8%a7%d8%aa/`,
    );
    const $ = parseHTML(html);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('figure.wp-block-image').each((_, el) => {
      const fig = $(el);
      const linkEl = fig.find('figcaption a').first();
      const href =
        linkEl.attr('href') || fig.find('a').first().attr('href') || '';
      const name = linkEl.text().trim();
      const cover = fig.find('img').attr('src') || '';

      if (name && href) {
        const path = href.replace(this.site, '').replace(/\/$/, '');
        if (!seen.has(path)) {
          seen.add(path);
          novels.push({ name, path, cover });
        }
      }
    });

    this.allNovels = novels;
    return novels;
  }

  async popularNovels(
    page: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    const allNovels = await this.loadAllNovels();
    if (page > 1) return [];
    return allNovels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: '',
      cover: '',
      summary: '',
      author: '',
      genres: '',
      status: '',
      chapters: [],
    };

    const html = await this.fetchHtml(`${this.site}${novelPath}`);
    const $ = parseHTML(html);

    const titleTag = $('title').text().trim();
    novel.name =
      titleTag.split(' - ')[0].trim() ||
      titleTag.split('\u2013')[0].trim() ||
      'بدون عنوان';

    novel.name = this.extractNovelName(novel.name);

    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    novel.cover = ogImage || '';

    const summaryEl = $('.entry-content p, .post-content p').first();
    novel.summary = summaryEl.text().trim() || '';

    let authorText = '';
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('المؤلف') || text.includes('كاتب')) {
        const parent = $(el).parent();
        const sibling = parent.next();
        if (sibling.length) {
          authorText = sibling.text().trim();
        } else {
          const parts = text.split(':');
          if (parts.length > 1) {
            authorText = parts[1].trim();
          }
        }
        return false;
      }
    });
    if (!authorText) {
      const authorEl = $('.author a, .novel-author a, .post-author a').first();
      authorText = authorEl.text().trim() || '';
    }
    novel.author = authorText;

    const genres: string[] = [];
    $('.genres a, .taxonomy a, .post-tags a, .category a').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) {
        genres.push(g);
      }
    });
    novel.genres = genres.join(', ');

    let statusText = '';
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('الحالة') || text.includes('Status')) {
        const parent = $(el).parent();
        const sibling = parent.next();
        if (sibling.length) {
          statusText = sibling.text().trim();
        } else {
          const parts = text.split(':');
          if (parts.length > 1) {
            statusText = parts[1].trim();
          }
        }
        return false;
      }
    });
    if (!statusText) {
      const statusEl = $('.status, .novel-status, .post-status').first();
      statusText = statusEl.text().trim() || '';
    }
    if (statusText.includes('مكتملة') || statusText.includes('Complete')) {
      novel.status = 'مكتملة';
    } else if (
      statusText.includes('مستمرة') ||
      statusText.includes('Ongoing')
    ) {
      novel.status = 'مستمرة';
    } else {
      novel.status = statusText;
    }

    const chapterSet = new Set<string>();
    const nextLink = $(
      'a:contains("التالي"), a:contains("Next"), a[rel="next"]',
    );

    const collectChaptersFromPage = (html: string, baseUrl: string) => {
      const $ = parseHTML(html);
      const chapterName = $('title').text().trim().split(' - ')[0].trim();
      const numMatch = chapterName.match(/(\d+)$/);
      const chapterNumber = numMatch ? parseInt(numMatch[1], 10) : 0;

      if (chapterNumber > 0 && !chapterSet.has(baseUrl)) {
        chapterSet.add(baseUrl);
        novel.chapters!.push({
          name: chapterName,
          path: baseUrl,
          chapterNumber,
        });
      }
    };

    collectChaptersFromPage(html, novelPath);

    let nextHref = nextLink.attr('href') || '';
    let safetyCounter = 0;
    while (nextHref && safetyCounter < 300) {
      safetyCounter++;
      const nextPath = nextHref.replace(this.site, '').replace(/\/$/, '');
      if (chapterSet.has(nextPath)) break;

      const nextHtml = await this.fetchHtml(nextHref);
      collectChaptersFromPage(nextHtml, nextPath);

      const next$ = parseHTML(nextHtml);
      nextHref =
        next$('a:contains("التالي"), a:contains("Next"), a[rel="next"]').attr(
          'href',
        ) || '';
      if (!nextHref || !nextHref.startsWith(this.site)) break;
    }

    novel.chapters!.sort(
      (a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0),
    );

    if (!novel.name && novel.chapters!.length > 0) {
      novel.name = this.extractNovelName(novel.chapters![0].name);
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const pages = await this.fetchJson<WPPage[]>(
      `${this.site}wp-json/wp/v2/pages?slug=${chapterPath}&_fields=content`,
    );

    const arr = Array.isArray(pages) ? pages : [pages];
    if (arr.length > 0 && arr[0].content?.rendered) {
      const $ = parseHTML(arr[0].content.rendered);
      $(
        'script, style, .sharedaddy, .jp-relatedposts, .wp-block-spacer, .simplefavorite-button',
      ).remove();
      return $.html();
    }

    const html = await this.fetchHtml(`${this.site}${chapterPath}/`);
    const $ = parseHTML(html);
    const content =
      $('article .entry-content, .post-content, .entry-content').html() || '';
    return content || '<p>المحتوى غير متاح.</p>';
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const allNovels = await this.loadAllNovels();
    const lower = searchTerm.toLowerCase();
    const filtered = allNovels.filter(n =>
      n.name.toLowerCase().includes(lower),
    );
    const perPage = 20;
    const start = (page - 1) * perPage;
    return filtered.slice(start, start + perPage);
  }

  private extractNovelName(title: string): string {
    const match = title.match(/^(.+?)\s+\d+$/);
    return match ? match[1].trim() : title.trim();
  }
}

export default new RewayahFans();
