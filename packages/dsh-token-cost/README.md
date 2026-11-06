# dsh-token-cost

Компактная плашка стоимости токенов вместо сырого текста о расходе: сколько стоят кэшированный и некэшированный ввод и вывод, какой процент попал в кэш, и пересчёт по курсу в выбранную валюту.

## Что делает

- заменяет текст о расходе токенов компактной оценкой стоимости;
- раскрывает простыми словами, что такое кэшированный ввод, некэшированный ввод, попадание в кэш и вывод;
- считает стоимость по ценам за миллион токенов и переводит её по заданному курсу.

## Установка

Через индекс маркета: DSH → **Plugins → Discover → Add index source** →
`https://ushmask.github.io/dsh-plugins/index.json`, затем **Install** у карточки плагина.

Вручную: скопируйте install-spec из карточки плагина (или из `site/index.json`) и выполните

```sh
dsh plugin --profile <profile> add <spec>
```

## Настройки

| Ключ | По умолчанию | Значение |
| --- | --- | --- |
| `currency` | `RUB` | Код валюты для отображения |
| `symbol` | `₽` | Символ валюты |
| `currencyRate` | `90` | Сколько валюты за 1 USD |
| `priceUncachedPerMillion` | `0.15` | USD за 1M некэшированных входящих токенов |
| `priceCachedPerMillion` | `0.003` | USD за 1M кэшированных входящих токенов |
| `priceOutputPerMillion` | `0.6` | USD за 1M исходящих токенов |

Цены по умолчанию соответствуют DeepSeek; поправьте их под свой тариф в `cordis.patch.yml` профиля:

```yaml
- id: token-cost
  name: dsh-token-cost
  config:
    currency: RUB
    symbol: '₽'
    currencyRate: 90
    priceUncachedPerMillion: 0.15
    priceCachedPerMillion: 0.003
    priceOutputPerMillion: 0.6
```

## Совместимость

DSH `>=0.2.2-rc.1 <0.3.0`, Web UI. Пакет уже собран: host-половина — `index.js`, клиентская — `client.js`; сборка при установке не нужна.

## Лицензия

MIT
