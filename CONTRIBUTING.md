# Как добавить свой плагин в этот маркет

Маркет — это репозиторий с пакетами и сгенерированным `site/index.json`. Добавить
плагин можно двумя способами: прислать pull request в `packages/` или попросить
владельца внести запись в `market.external.json`, если ваш код живёт в другом
репозитории или в npm.

## Требования к плагину

- Это DSH-бандл: в `package.json` есть `dsh.bundle.patch`; если у плагина есть UI —
  ещё и `dsh.client` с готовым `exports["./client"]`.
- **Пакет не собирается при установке.** Никаких `prepare`/`build`-скриптов:
  клиентская половина должна быть уже собрана (формат `window.__ModuleLoader__.load({...})`),
  иначе у каждого установившего pnpm попросит разрешение на build scripts.
- Имя пакета уникально в этом маркете. Рекомендуем `dsh-<ваш-ник>-<название>`, например
  `dsh-ivan-spotlight`. Оно обязано совпадать с:
  - папкой в `packages/`,
  - полем `name` в `package.json`,
  - `id` в `client.js` (`window.__ModuleLoader__.load({ id: ... })`),
  - `name:` в `cordis.patch.yml`.
- Объявите `engines.dsh` — версию DSH, на которой вы реально проверяли плагин.
- В комплекте: `README.md` (показывается в карточке плагина), `LICENSE`, `icon.svg`
  (или PNG/JPG/WebP), `locale/en.json` и `locale/ru.json` с `meta.title`/`meta.description`.

## Способы публикации

### A. Pull request в этот репозиторий (рекомендуется)

1. Сделайте форк, затем ветку: `git checkout -b feat/my-plugin`.
2. Скопируйте пакет в `packages/dsh-<ваш-ник>-<название>/`.
3. Приведите `package.json` в порядок:
   - `name` — как у папки, `version` — `1.0.0`;
   - `author` — ваше имя; `engines.dsh` — протестированная версия;
   - `repository.url` — `git+https://github.com/UshMask/dsh-plugins.git`,
     `repository.directory` — `packages/<папка>`;
   - `homepage` и `bugs` — на этот репозиторий; `keywords` — начните с `dsh`, `dsh-plugin`.
4. Добавьте запись в `plugins` в `market.config.json` (необязательно, но полезно для
   категорий и поиска):

   ```json
   "dsh-ivan-spotlight": {
     "category": "ui",
     "keywords": ["ui", "spotlight"]
   },
   ```

   Категорию берите из уже объявленных в `categories` или добавьте свою с `title.en`.
5. Проверьте локально:

   ```powershell
   node scripts/generate-index.mjs --check
   ```

   Генератор проверит манифесты, `engines.dsh`, наличие patch-файла и клиентского
   бандла, совпадение id клиента с именем пакета, уникальность имён и иконки.
6. Коммит, пуш, pull request. CI `Validate marketplace changes` должен стать зелёным.
7. После мержа workflow сам пересоберёт индекс и задеплоит его — плагин появится
   в **Plugins → Discover** у всех, кто добавил индекс.

Обновление версии: поднять `version` в `package.json`, повторить пункты 5–6.
В индексе остаётся только новая версия; у тех, кто уже установил старую, она продолжит
работать, пока они не обновятся.

### B. Без доступа к репозиторию (`market.external.json`)

Если не хотите давать доступ к этому репозиторию, оставьте плагин у себя: опубликуйте
его в своём публичном git-репозитории или в npm и передайте владельцу маркета имя,
ссылку и пин (коммит для git или версию для npm), `engines.dsh`, заголовок и описание.
Владелец добавит запись в `market.external.json`, и индекс будет ставить плагин
из вашего источника.

```json
{
  "plugins": [
    {
      "name": "dsh-ivan-spotlight",
      "title": { "en": "Spotlight", "ru": "Прожектор" },
      "description": { "en": "Finds things in the conversation.", "ru": "Ищет по диалогу." },
      "icon": "https://raw.githubusercontent.com/ivan/dsh-spotlight/main/icon.svg",
      "author": "Ivan",
      "homepage": "https://github.com/ivan/dsh-spotlight",
      "repository": { "url": "https://github.com/ivan/dsh-spotlight" },
      "metadata": { "category": "ui", "keywords": ["search"] },
      "versions": [
        {
          "version": "1.2.0",
          "publishTimestamp": 1794000000,
          "source": {
            "type": "git",
            "url": "https://github.com/ivan/dsh-spotlight",
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "path": "."
          },
          "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
        }
      ]
    }
  ]
}
```

Для npm-источника: `"source": { "type": "npm" }`, а версия должна быть уже
опубликована в реестре. `publishTimestamp` — время публикации/коммита в Unix-секундах.

## Что проверяет ревьюер

- Плагин действительно работает на указанной в `engines.dsh` версии DSH.
- В файлах нет секретов, токенов и личных данных.
- Нет install-скриптов (`prepare`, `build`, `postinstall`) — пакет уже собран.
- Указана лицензия; чужой код включён на совместимых условиях.
- Иконка и README не вводят в заблуждение, имя пакета не занято.

## Важно

Индекс не подписан. Кто может писать в репозиторий (или в `market.external.json`),
тот определяет, что установится у всех пользователей маркета, — поэтому основной путь
это PR с ревью, а не прямой доступ на запись.
