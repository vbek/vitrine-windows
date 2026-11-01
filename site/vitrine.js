(function () {
  var config = window.VITRINE_CONFIG || {};
  var release = window.VITRINE_RELEASE;
  var button = document.getElementById('download');
  var meta = document.getElementById('meta');

  if (config.backHref) {
    var back = document.getElementById('back');
    back.href = config.backHref;
    back.hidden = false;
  }

  var repoSet = /^[\w.-]+\/[\w.-]+$/.test(config.githubRepo || '') && config.githubRepo.indexOf('YOUR-USERNAME') !== 0;
  if (!repoSet || !release) {
    button.addEventListener('click', function (e) { e.preventDefault(); });
    meta.textContent = 'The download isn\'t available yet.';
    return;
  }

  button.href = 'https://github.com/' + config.githubRepo + '/releases/download/v' + release.version + '/Vitrine-Windows-x64.zip';
  button.removeAttribute('aria-disabled');
  meta.textContent = 'Version ' + release.version + ' · ' + release.sizeMb + ' MB · Windows 10 or 11, 64-bit';
  document.getElementById('hash').textContent = release.sha256;
  document.getElementById('hash-row').hidden = false;
})();
