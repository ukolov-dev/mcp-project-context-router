document.querySelectorAll('.copy').forEach((button) => {
  button.addEventListener('click', async () => {
    const code = button.closest('.code-block').querySelector('code');
    const label = button.querySelector('span');
    try {
      await navigator.clipboard.writeText(code.textContent);
      label.textContent = document.body.dataset.copied;
      document.querySelector('#copy-status').textContent = document.body.dataset.copied;
      setTimeout(() => { label.textContent = document.body.dataset.copy; }, 1800);
    } catch {
      const range = document.createRange();range.selectNodeContents(code);
      const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range);
      document.querySelector('#copy-status').textContent = document.body.dataset.copyFailed;
    }
  });
});
