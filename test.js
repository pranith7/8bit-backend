import puppeteer from 'puppeteer';

async function fetchUsingXPath(symbol) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`https://www.google.com/finance/quote/${symbol}`, {
    waitUntil: 'networkidle2',
  });

  // Wait for relevant data to load (adjust timeout if needed)
  await page.waitForXPath('//*[@id="yDmH0d"]/c-wiz[3]/div/div[4]/div/main/div[2]/div[2]/div[7]', {
    timeout: 10000,
  });

  // Extract P/E Ratio
  const [peNode] = await page.$x('//*[@id="yDmH0d"]/c-wiz[3]/div/div[4]/div/main/div[2]/div[2]/div[7]');
  const [epsNode] = await page.$x('//*[@id="c672"]/div/table/tr[6]');

  const peRatio = peNode ? await page.evaluate(el => el.textContent, peNode) : null;
  const earnings = epsNode ? await page.evaluate(el => el.textContent, epsNode) : null;

  await browser.close();

  console.log('✅ P/E Ratio:', peRatio?.trim());
  console.log('✅ EPS:', earnings?.trim());

  return {
    peRatio: peRatio?.trim() || null,
    latestEarnings: earnings?.trim() || null,
  };
}

// Example usage
fetchUsingXPath('SBILIFE:NSE');
