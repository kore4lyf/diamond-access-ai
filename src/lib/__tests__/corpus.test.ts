/**
 * Diamond Access AI — Corpus tests for robust extractor (Phase M)
 * Shared change 3: dedupe contract verification
 */

import { describe, it, expect, afterEach } from 'vitest';
import { extractMainContent } from '../main-content';

const containers: HTMLElement[] = [];

function fixture(html: string): HTMLElement {
  // Reset lang attribute for each test
  document.documentElement.lang = '';
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  containers.push(div);
  return div;
}

afterEach(() => {
  for (const c of containers) {
    if (c.parentNode) c.parentNode.removeChild(c);
  }
  containers.length = 0;
});

describe('corpus shapes', () => {
  // Shape 1: news-article (BBC-style)
  it('news-article: extracts article prose, ignores nav/footer', () => {
    const lastPara = 'This is the concluding paragraph of the news article.';
    fixture(`
      <nav><a href="/">Home</a><a href="/news">News</a></nav>
      <main><article>
        <h1>Breaking News</h1>
        <p>First paragraph with the opening story content here.</p>
        <p>Second paragraph provides additional context and details.</p>
        <p>${lastPara}</p>
      </article></main>
      <footer>Copyright 2026 News Corp</footer>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('Breaking News');
    expect(result.prose).toContain('opening story');
    expect(result.prose).not.toContain('Home');
    // Dedupe contract: last paragraph appears exactly once
    expect(result.prose.indexOf(lastPara)).toBe(result.prose.lastIndexOf(lastPara));
  });

  // Shape 2: recipe
  it('recipe: emits ingredients + steps', () => {
    fixture(`
      <article class="recipe">
        <h1>Chicken Bhuna</h1>
        <p>A simple weeknight curry with deep spice flavors.</p>
        <h2>Ingredients</h2>
        <ul>
          <li>500g chicken thighs</li>
          <li>2 onions, diced</li>
          <li>3 cloves garlic, minced</li>
          <li>2 tsp garam masala</li>
        </ul>
        <h2>Method</h2>
        <ol>
          <li>Heat oil and brown the chicken.</li>
          <li>Add onions and cook until soft.</li>
          <li>Stir in spices and simmer.</li>
        </ol>
      </article>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('chicken thighs');
    expect(result.prose).toContain('garam masala');
    expect(result.prose).toContain('Heat oil');
  });

  // Shape 3: forum-thread
  it('forum-thread: extracts post content', () => {
    const lastPara = 'This is my final point in the forum post.';
    fixture(`
      <article class="post">
        <h1>How to fix this issue?</h1>
        <p>I am having trouble with my code.</p>
        <p>The error message says something about null reference.</p>
        <p>${lastPara}</p>
      </article>
      <ul class="replies">
        <li>Try checking your imports.</li>
        <li>Make sure you initialized the variable.</li>
      </ul>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('error message');
    expect(result.prose).toContain('Try checking');
    // Dedupe contract
    expect(result.prose.indexOf(lastPara)).toBe(result.prose.lastIndexOf(lastPara));
  });

  // Shape 4: product-spec-table (Path B)
  it('product-spec-table: captures td/th text', () => {
    fixture(`
      <div class="product">
        <h1>Widget Pro</h1>
        <table>
          <tr><th>Weight</th><td>1.5 kg</td></tr>
          <tr><th>Battery</th><td>8 hours</td></tr>
          <tr><th>RAM</th><td>16 GB</td></tr>
        </table>
        <p>Order now for fast delivery.</p>
      </div>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('Weight');
    expect(result.prose).toContain('1.5 kg');
    expect(result.prose).toContain('Battery');
    expect(result.prose).toContain('8 hours');
  });

  // Shape 5: spa-loose-divs (Path B)
  it('spa-loose-divs: captures direct div text', () => {
    const uniqueText = 'Unique SPA text that should appear only once.';
    fixture(`
      <div class="app-content">
        <h1>SPA Page</h1>
        <div>${uniqueText}</div>
        <div>Another paragraph of text in a loose div wrapper.</div>
      </div>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('SPA Page');
    expect(result.prose).toContain(uniqueText);
    // Dedupe contract
    expect(result.prose.indexOf(uniqueText)).toBe(result.prose.lastIndexOf(uniqueText));
  });

  // Shape 6: readme
  it('readme: emits headings + paragraphs', () => {
    const lastLine = 'This is the final line of the README.';
    fixture(`
      <article class="markdown-body">
        <h1>Project Overview</h1>
        <p>This library handles retry semantics for HTTP requests.</p>
        <h2>Installation</h2>
        <p>Install via npm install retry-http.</p>
        <h2>Usage</h2>
        <p>${lastLine}</p>
      </article>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('retry semantics');
    expect(result.prose).toContain('npm install retry-http');
    expect(result.prose.indexOf(lastLine)).toBe(result.prose.lastIndexOf(lastLine));
  });

  // Shape 7: non-english
  it('non-english: respects lang attribute', () => {
    document.documentElement.lang = 'es';
    const lastPara = 'Este es el párrafo final del artículo en español.';
    fixture(`
      <article>
        <h1>Noticias en Español</h1>
        <p>Primer párrafo con contenido de la noticia.</p>
        <p>${lastPara}</p>
      </article>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('Noticias en Español');
    expect(result.prose).toContain('Primer párrafo');
    expect(result.prose.indexOf(lastPara)).toBe(result.prose.lastIndexOf(lastPara));
  });

  // Shape 8: government-policy
  it('government-policy: dense paragraphs extract', () => {
    const lastPara = 'This concludes the policy document for the fiscal year.';
    fixture(`
      <main>
        <h1>Policy Document</h1>
        <p>The government hereby establishes the following guidelines.</p>
        <p>All agencies must comply with the new regulations.</p>
        <p>${lastPara}</p>
      </main>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('government hereby establishes');
    expect(result.prose.indexOf(lastPara)).toBe(result.prose.lastIndexOf(lastPara));
  });

  // Shape 9: wiki-encyclopedia
  it('wiki-encyclopedia: captures infobox table', () => {
    fixture(`
      <div class="mw-parser-output">
        <h1>Albert Einstein</h1>
        <p>German-born physicist who developed relativity theory.</p>
        <table class="infobox">
          <tr><th>Born</th><td>March 14, 1879</td></tr>
          <tr><th>Died</th><td>April 18, 1955</td></tr>
        </table>
        <p>He won the Nobel Prize in Physics.</p>
      </div>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('physicist');
    expect(result.prose).toContain('Born');
    expect(result.prose).toContain('March 14');
  });

  // Shape 10: search-results
  it('search-results: extracts snippets', () => {
    const lastSnippet = 'This is the last search result snippet.';
    fixture(`
      <div class="search-results">
        <div class="result">
          <h3>Result one</h3>
          <p>First result snippet with relevant content.</p>
        </div>
        <div class="result">
          <h3>Result two</h3>
          <p>${lastSnippet}</p>
        </div>
      </div>
    `);

    const result = extractMainContent();
    expect(result.prose).toContain('result snippet');
    expect(result.prose.indexOf(lastSnippet)).toBe(result.prose.lastIndexOf(lastSnippet));
  });
});