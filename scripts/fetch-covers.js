/**
 * 把还没存到本地的封面下载下来（断网/图片站挂了也能正常看书架）。
 *   node scripts/fetch-covers.js [并发数]
 */
process.removeAllListeners('warning');

const { db } = require('../src/db');
const meta = require('../src/services/metadata');

async function main() {
  const concurrency = Number(process.argv[2] || 6);
  const jobs = db
    .prepare(
      "SELECT id, title, isbn13, cover_url FROM books WHERE cover_url IS NOT NULL AND cover_url <> '' AND (cover_path IS NULL OR cover_path = '')"
    )
    .all();

  if (!jobs.length) {
    console.log('没有需要下载的封面。');
    return;
  }
  console.log(`待下载 ${jobs.length} 张封面，并发 ${concurrency}…`);

  let ok = 0;
  let fail = 0;
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const job = queue.shift();
        const name = await meta.cacheCover(job.cover_url, job.isbn13 || job.title);
        if (name) {
          db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(name, job.id);
          ok++;
        } else {
          fail++;
        }
        if ((ok + fail) % 20 === 0) console.log(`  进度 ${ok + fail}/${jobs.length}（成功 ${ok}）`);
      }
    })
  );
  console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
  if (fail) console.log('失败的多半是图片站连不上，可以在「设置」里开代理后重跑。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
