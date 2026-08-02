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

  async popularNovels(page: number): Promise<Plugin.NovelItem[]> {
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

    // Get novel name from <title> tag (format: "Novel Name - ...")
    const titleTag = $('title').text().trim();
    novel.name =
      titleTag.split(' - ')[0].trim() ||
      titleTag.split('–')[0].trim() ||
      'بدون عنوان';

    // Cover image
    const coverImg = $(
      'img.wp-post-image, .entry-image img, .post-thumbnail img, figure.wp-block-image img',
    ).first();
    novel.cover = coverImg.attr('src') || coverImg.attr('data-src') || '';

    // Summary
    const summaryEl = $('.entry-content p, .post-content p').first();
    novel.summary = summaryEl.text().trim() || '';

    // Author
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
    // Fallback: .author a
    if (!authorText) {
      const authorEl = $('.author a, .novel-author a, .post-author a').first();
      authorText = authorEl.text().trim() || '';
    }
    novel.author = authorText;

    // Genres
    const genres: string[] = [];
    $('.genres a, .taxonomy a, .post-tags a, .category a').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) {
        genres.push(g);
      }
    });
    novel.genres = genres.join(', ');

    // Status
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

    // Chapters
    const chapterSet = new Set<string>();

    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();

      if (!href || !text) return;
      if (!href.startsWith(this.site)) return;

      const chapterPath = href.replace(this.site, '').replace(/\/$/, '');
      if (
        chapterPath === novelPath ||
        chapterPath === novelPath.replace(/\/$/, '')
      )
        return;
      if (chapterSet.has(chapterPath)) return;

      const numMatch = text.match(/(\d+)/);
      if (!numMatch) return;

      chapterSet.add(chapterPath);
      novel.chapters!.push({
        name: text,
        path: chapterPath,
        chapterNumber: parseInt(numMatch[1], 10),
      });
    });

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
