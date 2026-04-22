import type { MediaType } from '@server/constants/media';
import logger from '@server/logger';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { decode } from 'html-entities';
import path from 'path';

interface ICheckUaResult {
  title: string;
  originalTitle: string;
  year: string;
  uaAudio: boolean;
  uaSubs: boolean;
  uaReasons?: string[];
}

interface ICheckUa {
  found: number;
  query: {
    type: MediaType;
    title: string;
    year: string;
    originalTitle?: string;
    kinobazaUrl: string;
  };
  mostRelevant: ICheckUaResult | null;
  results: ICheckUaResult[];
  fromCache?: boolean;
}

function parseSingle(src: string, rgx: RegExp) {
  return decode(src.match(rgx)?.[1] || '');
}

function parseArray(src: string, rgx: RegExp) {
  let item;
  const arr = [];
  while ((item = rgx.exec(src))) {
    arr.push(item[1]);
  }
  return arr;
}

class checkUA {
  static cacheFile = process.env.CONFIG_DIRECTORY
    ? `${process.env.CONFIG_DIRECTORY}/kinobazaCache.json`
    : path.join(__dirname, '../../config/kinobazaCache.json');
  // static DBget(tmdbId: number) {
  //   const db = new sqlite3.Database(
  //     process.env.CONFIG_DIRECTORY
  //       ? `${process.env.CONFIG_DIRECTORY}/db/kinobazaCache.db`
  //       : path.join(__dirname, '../../config/db/kinobazaCache.db')
  //   );
  //   db.run(`CREATE TABLE IF NOT EXISTS cache(
  //     tmdbId INTEGER PRIMARY KEY,
  //     data BLOB NOT NULL
  //   )`);
  //   const row: { data?: ICheckUa } = db
  //     .prepare(`SELECT data FROM cache WHERE tmdbId = ?`)
  //     .get(tmdbId);
  //   db.close();
  //   return row ? row.data : undefined;
  // }

  public static async directFromKinobaza(
    tmdbId: number,
    type: MediaType,
    title: string,
    originalTitle: string,
    ys: string,
    ye?: string
  ): Promise<ICheckUa | undefined> {
    title = title.replace(/\s+/g, ' ').trim();
    originalTitle = originalTitle.replace(/\s+/g, ' ').trim();
    if (!/^\d{4}$/.test(ys)) ys = parseSingle(ys, /(\d{4})/) || ys;
    if (!ye) ye = ys;
    if (!/^\d{4}$/.test(ye)) ye = parseSingle(ye, /(\d{4})/) || ye;

    try {
      const { status, data, request } = await axios.get(
        'https://kinobaza.com.ua/titles',
        {
          params: {
            q: originalTitle || title,
            order_by: 'views',
            type: type == 'movie' ? 1 : 2,
            ys,
            ye,
            per_page: 100,
          },
          timeout: 30000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        }
      );
      if (status == 200) {
        const $ = cheerio.load(data),
          results = [];
        let mostRelevant: ICheckUaResult | null = null;
        for (const block of $('div > div > div > div[class^="row"]')
          .toArray()
          .map((page) => $.html(page))) {
          const obj: ICheckUaResult = {
            title: parseSingle(
              block,
              /<span itemprop="name">\s*(.+?)\s*<\/span>/
            )
              .replace(/\s+/g, ' ')
              .trim(),
            originalTitle: parseSingle(
              block,
              /<h4[^>]+class="text-muted[^>]+>\s*(.+?)\s*<\/h4>/
            )
              .replace(/\s+/g, ' ')
              .trim(),
            year: parseSingle(
              block,
              /<span itemprop="name">.+?<\/span>\s*<\/a>\s*<small class="text-muted">\s*\(([^)]+?)\)\s*<\/small/
            ).replace(/—/g, '-'),
            uaAudio: />\s*Є\s+українське\s+аудіо\s*<|укр\.\s+аудіо/i.test(
              block
            ),
            uaSubs: />\s*Є\s+українські\s+субтитри\s*<|укр\.\s+субтитри/i.test(
              block
            ),
          };

          const haveUa = parseSingle(
            block,
            /class="mt-2 bg-body-secondary rounded[^>]+>\s*(?:<i.+?\/i>\s*)?(.+?)\s*<\/div>/
          );
          const servUa: { [key: string]: number } = {};
          for (const item of parseArray(
            block,
            /<a[^>]+rel="nofollow noopener".+?\/a>\s*\(([^)]+)/g
          )) {
            for (const part of item.split(/\s*,\s*/)) {
              servUa[part] = 1;
            }
          }
          obj.uaReasons = [...(haveUa ? [haveUa] : []), ...Object.keys(servUa)];

          if (
            (obj.title.toLowerCase() == title.toLowerCase() ||
              obj.originalTitle.toLowerCase() == title.toLowerCase() ||
              obj.title.toLowerCase() == originalTitle.toLowerCase() ||
              obj.originalTitle.toLowerCase() == originalTitle.toLowerCase()) &&
            (obj.year.includes(ys) || obj.year.includes(ye))
          ) {
            mostRelevant = obj;
          }

          results.push(obj);
        }

        if (!mostRelevant) {
          // TODO: запит на кінобазу з авторизацією і звірка по imdb
        }

        const result = {
          found: parseInt(parseSingle(data, /Знайдено\s+(\d+)\s+резул/)),
          query: {
            type,
            title,
            year: ys,
            kinobazaUrl: `https://kinobaza.com.ua${request.path}`,
          },
          mostRelevant,
          results,
        };

        if (mostRelevant?.uaAudio && existsSync(this.cacheFile)) {
          const cache: { [key: number]: ICheckUa } = JSON.parse(
            readFileSync(this.cacheFile).toString()
          );
          cache[tmdbId] = result;
          writeFileSync(this.cacheFile, JSON.stringify(cache));
        }

        return result;
      }
    } catch (err) {
      if (err instanceof AxiosError) {
        logger.error(`Axios error with code ${err.code}`, {
          label: 'checkUA',
          errorMessage: err.message,
        });
      } else if (err instanceof Error) {
        logger.error(`Error directFromKinobaza`, {
          label: 'checkUA',
          errorMessage: err.message,
        });
      } else {
        logger.error(`Unknown error on directFromKinobaza`, {
          label: 'checkUA',
        });
      }
    }
  }

  public static async fromCache(tmdbId: number): Promise<ICheckUa | undefined> {
    if (!existsSync(this.cacheFile)) {
      writeFileSync(this.cacheFile, '{}');
    }

    const cache: { [key: number]: ICheckUa } = JSON.parse(
      readFileSync(this.cacheFile).toString()
    );
    if (cache[tmdbId]) {
      return { ...cache[tmdbId], fromCache: true };
    }
  }
}

export default checkUA;
