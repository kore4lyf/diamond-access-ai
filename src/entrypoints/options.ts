// Diamond Access AI — Options Page
// Phase A: minimal — API key input, persist via chrome.storage.local

import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

export default defineUnlistedScript(() => {
  const container = document.createElement('div');
  container.style.padding = '16px';
  container.style.fontFamily = 'system-ui, sans-serif';

  const heading = document.createElement('h2');
  heading.textContent = 'Diamond Access AI — Settings';
  container.appendChild(heading);

  const label = document.createElement('label');
  label.textContent = 'Fireworks API Key:';
  label.style.display = 'block';
  label.style.marginTop = '12px';
  container.appendChild(label);

  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'Enter your Fireworks AI API key';
  input.style.width = '100%';
  input.style.maxWidth = '400px';
  input.style.marginTop = '4px';
  input.style.padding = '6px';
  container.appendChild(input);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.style.marginTop = '12px';
  saveBtn.style.padding = '6px 16px';
  container.appendChild(saveBtn);

  const status = document.createElement('p');
  status.style.marginTop = '8px';
  status.style.fontSize = '14px';
  container.appendChild(status);

  // Load existing key on mount
  chrome.storage.local.get('diamond_api_key').then((result) => {
    const savedKey = result.diamond_api_key as string | undefined;
    if (savedKey) {
      input.value = savedKey;
    }
  });

  // Save on button click
  saveBtn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) {
      status.textContent = 'Please enter a valid API key.';
      status.style.color = 'red';
      return;
    }
    await chrome.storage.local.set({ diamond_api_key: key });
    status.textContent = 'API key saved!';
    status.style.color = 'green';
  });

  document.body.appendChild(container);
});
