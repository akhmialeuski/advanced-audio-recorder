# План улучшения тестов

Сводный план по итогам трёх аудитов: покрытия, качества тест-сьюта и возможностей
инструментов (Jest 30 / ts-jest / jsdom / Obsidian API).

Документ рассчитан на последовательное исполнение. Этапы упорядочены так, что
каждый следующий дешевле благодаря предыдущему; порядок менять не следует.

---

## 1. Базовая линия (заморожена)

Все числа сняты на коммите `05a33d5` командой `npm run test:coverage` и
вспомогательными замерами по `tests/`. Это точка отсчёта: любой критерий
приёмки ниже сравнивается именно с ней.

### 1.1 Покрытие

| Метрика    | Факт                    | Порог в `package.json` | Запас |
| ---------- | ----------------------- | ---------------------- | ----- |
| Statements | 93.05 % (10353 / 11126) | 91                     | +2.05 |
| Branches   | 84.90 % (4258 / 5015)   | 83                     | +1.90 |
| Functions  | 90.49 % (2142 / 2367)   | 86                     | +4.49 |
| Lines      | 93.06 % (10203 / 10963) | 91                     | +2.06 |

Непокрытых стейтментов — 773. Порог 91 % допускает до 1001, то есть запас
составляет 228 стейтментов.

### 1.2 Покрытие по каталогам (слабые зоны)

| Каталог                          | stmt % | br % | fn % | непокрыто |
| -------------------------------- | ------ | ---- | ---- | --------- |
| `src` (корень, преим. `main.ts`) | 82.6   | 72.4 | 53.4 | 84        |
| `src/player/views`               | 84.0   | 65.6 | 82.7 | 38        |
| `src/player`                     | 87.2   | 77.1 | 84.8 | 182       |
| `src/actions`                    | 90.3   | 94.4 | 75.0 | 7         |
| `src/ui`                         | 90.3   | 81.6 | 81.5 | 136       |

Остальные 18 каталогов — 93–100 %. Единственный per-directory порог в конфиге
стоит на `src/platform/` (90/90/90), который и так покрыт на 100 %.

### 1.3 Сьют

| Показатель                        | Значение                             |
| --------------------------------- | ------------------------------------ |
| Тест-файлов                       | 171 (unit 164, integration 7, e2e 0) |
| Тест-кейсов                       | 2776 (объявлений `it`/`test` — 2631) |
| Ассертов `expect`                 | 5531                                 |
| Время прогона                     | ~23 с                                |
| `.skip` / `.only` / `.todo`       | 0                                    |
| Строк в тест-файлах (`*.test.ts`) | 58 113                               |
| Всего файлов и строк в `tests/`   | 184 файла, 61 525 строк              |

### 1.4 Инварианты, которые нельзя нарушить ни на одном этапе

| ID    | Инвариант                                                 | Проверка                                 |
| ----- | --------------------------------------------------------- | ---------------------------------------- |
| INV-1 | Ни одна из четырёх метрик покрытия не ниже базовой линии  | `scripts/coverage-diff.mjs` (задача 0.5) |
| INV-2 | Покрытие ни одного файла `src/**` не ниже базовой линии   | тот же скрипт, пофайловый режим          |
| INV-3 | Число тест-кейсов не меньше 2776                          | `npx jest --listTests` + счётчик прогона |
| INV-4 | Прогон зелёный при случайном порядке                      | `npx jest --randomize`                   |
| INV-5 | `npm run lint` и `npm run typecheck` зелёные              | CI                                       |
| INV-6 | Ни один тест не удалён без замены эквивалентным по смыслу | ревью диффа                              |

Пояснение к INV-3: параметризация счётчик не уменьшает — `it.each` с N строками
даёт N тест-кейсов в отчёте. Поэтому «не меньше 2776» остаётся валидным
инвариантом и на этапе параметризации.

### 1.5 Общее определение готовности (DoD) для любой задачи

Задача считается выполненной, только если одновременно:

1. Соблюдены INV-1 … INV-6.
2. Прогон `npm run test:coverage` зелёный.
3. Прогон `npx jest --randomize` зелёный (начиная с этапа 1).
4. Проверяемая команда из графы «Критерий приёмки» даёт заявленный результат.
5. Изменение оформлено отдельным коммитом с описанием, ссылающимся на ID задачи.

---

## Этап 0. Защитный контур

**Цель.** Сделать деградацию покрытия и качества технически невозможной до того,
как начнётся любой рефакторинг. Этап не меняет ни одного теста по существу.

**Обоснование.** Запас до порога — 228 стейтментов. Рефакторинг такого масштаба,
как в этапах 2–4, способен незаметно съесть его целиком.

### Задача 0.1 — Поднять глобальные пороги до фактических значений

**Находка.** Пороги 91/83/86/91 при факте 93.05/84.90/90.49/93.06.

**Действие.** Выставить в `package.json` → `jest.coverageThreshold.global`:
statements 92.5, branches 84.4, functions 90.0, lines 92.5 (факт минус ~0.5 п.п.
на шум ветвлений).

**Критерий приёмки.**

```bash
npm run test:coverage        # зелёный
node -e "const t=require('./package.json').jest.coverageThreshold.global; \
  console.log(t.statements>=92.5 && t.branches>=84.4 && t.functions>=90 && t.lines>=92.5)"
# true
```

**Критерий успеха.** Искусственное удаление любого теста из
`tests/unit/TimeUtils.test.ts` роняет `npm run test:coverage` по порогу.

### Задача 0.2 — Добавить per-directory пороги на слабые зоны

**Находка.** Единственный локальный порог стоит на `src/platform/`, уже
покрытом на 100 %. Слабые `src/`, `src/player/`, `src/player/views/`, `src/ui/`,
`src/actions/` не защищены ничем.

**Действие.** Добавить в `coverageThreshold` записи, равные текущему факту минус
0.5 п.п.: `src/` (82/72/53), `src/player/` (86.5/76.5/84), `src/player/views/`
(83.5/65/82), `src/ui/` (89.5/81/81), `src/actions/` (89.5/94/74.5).

Значения намеренно низкие — это фиксация текущего состояния, а не цель. Цели
поднимаются в задачах 6.9 и 7.5.

**Критерий приёмки.**

```bash
npm run test:coverage        # зелёный
node -e "const t=require('./package.json').jest.coverageThreshold; \
  console.log(Object.keys(t).length >= 7)"
# true
```

**Критерий успеха.** Удаление любого теста из `tests/unit/RibbonIcon.test.ts`
роняет сборку по порогу каталога `src/ui/`, а не только по глобальному.

### Задача 0.3 — Скрипт пофайловой проверки регрессии покрытия

**Находка.** Глобальные пороги не ловят ситуацию «один файл упал на 15 п.п., а
другой вырос» — суммарно метрика та же.

**Действие.** Написать `scripts/coverage-diff.mjs`:

- принимает базовый `coverage-summary.json` и текущий;
- падает с кодом 1, если любая из четырёх метрик глобально ниже базовой;
- падает, если покрытие любого файла `src/**` ниже базового более чем на 0.01 п.п.;
- печатает таблицу изменений (выросло / упало / без изменений);
- поддерживает флаг `--update-baseline` для осознанного обновления.

Базовую линию хранить в `tests/coverage-baseline.json`, коммитить в репозиторий.

**Критерий приёмки.**

```bash
npm run test:coverage
node scripts/coverage-diff.mjs           # exit 0
# намеренно закомментировать один it() и повторить:
node scripts/coverage-diff.mjs           # exit 1 с указанием файла
```

**Критерий успеха.** Скрипт указывает конкретный файл и метрику, а не только
факт регрессии.

### Задача 0.4 — Подключить проверку в CI

**Действие.** В `.github/workflows/ci.yml` после шага `npm run test:coverage`
добавить `node scripts/coverage-diff.mjs`.

**Критерий приёмки.** PR с искусственно удалённым тестом получает красный CI на
шаге coverage-diff.

**Критерий успеха.** Красный шаг называет файл и метрику в логе Actions.

### Задача 0.5 — Зафиксировать инвентарь сьюта

**Действие.** Добавить в `scripts/coverage-diff.mjs` (или отдельным
`scripts/suite-stats.mjs`) вывод: число сьютов, число тест-кейсов, число файлов
`tests/**`, суммарные строки. Записать базовую линию в тот же
`tests/coverage-baseline.json`.

**Критерий приёмки.**

```bash
node scripts/suite-stats.mjs
# suites: 171, tests: 2776, files: 184, lines: 61525
```

**Критерий успеха.** Скрипт падает, если число тест-кейсов упало ниже
зафиксированного (реализация INV-3).

### Критерий завершения этапа 0

- Все пять задач закрыты по своим DoD.
- CI содержит шаги: build → lint → test:coverage → coverage-diff.
- Демонстрация: ветка с удалённым тестом даёт красный CI на двух независимых
  шагах (порог и coverage-diff).
- Ни один файл в `tests/` не изменён по существу (допустим только `package.json`,
  `ci.yml`, новые скрипты и baseline).

**Риск и откат.** Риск отсутствует, изменения аддитивны. Откат — revert коммита.

---

## Этап 1. Изоляция тестов

**Цель.** Устранить зависимость тестов от порядка выполнения и от общего
изменяемого состояния, включить `--randomize` в CI. Без этого любой рефакторинг
в этапах 2–4 может «починить» или «сломать» тесты случайно, и это будет
невозможно диагностировать.

**Обоснование.** Прогон `npx jest --randomize` (seed 1747347904) даёт
**3 падения из 2776** при полностью зелёном обычном прогоне.

### Задача 1.1 — Починить мутацию прототипа в `TestRecorder.test.ts`

**Находка.** `tests/unit/TestRecorder.test.ts:132`:

```ts
MockMediaRecorder.prototype.start = jest.fn(() => {
	throw new Error('recorder failed');
});
```

Присваивание навсегда заменяет метод прототипа и никогда не восстанавливается.
В объявленном порядке тест идёт последним, поэтому CI зелёный. При случайном
порядке падают два соседних теста: «records the raw stream in the source mode» и
«records through the mono bridge in a mono mode and releases it». Это
единственная мутация прототипа во всём сьюте (grep: 1 из 1).

**Действие.** Заменить на
`jest.spyOn(MockMediaRecorder.prototype, 'start').mockImplementation(() => { throw … })`.
Восстановление обеспечит уже включённый `restoreMocks: true`.

**Критерий приёмки.**

```bash
npx jest tests/unit/TestRecorder.test.ts --randomize   # зелёный на 5 разных seed
grep -rn "prototype\.[a-zA-Z]* *=" tests --include='*.test.ts' | grep -v spyOn
# пусто
```

**Критерий успеха.** Все три теста файла проходят в любом из 5 проверенных
порядков; покрытие `src/recording/TestRecorder.ts` не изменилось.

### Задача 1.2 — Починить утечку общих настроек в `SplitModal.test.ts`

**Находка.** Тест «compressed path › should decode once and encode each part»
ожидает `format: 'webm'`, а при случайном порядке получает `'wav'`: предыдущий
тест оставляет после себя мутированный общий объект настроек.

**Действие.** Перевести объект настроек на создание внутри `beforeEach` (или, что
лучше, внутри фабрики `createSut` — но полноценно это делается в задаче 3.4;
здесь достаточно локального `beforeEach`).

**Критерий приёмки.**

```bash
npx jest tests/unit/SplitModal.test.ts --randomize   # зелёный на 5 разных seed
```

**Критерий успеха.** Ни один тест файла не читает состояние, записанное другим
тестом; покрытие `src/ui/SplitModal.ts` не изменилось.

### Задача 1.3 — Аудит остальных 169 сьютов на зависимость от порядка

**Действие.** Прогнать `npx jest --randomize` на 10 различных seed. Каждое
падение разобрать как 1.1/1.2 — найти источник общего состояния, изолировать.

**Критерий приёмки.**

```bash
for s in 1 2 3 5 8 13 21 34 55 89; do npx jest --randomize --seed=$s --silent || exit 1; done
# все 10 зелёные
```

**Критерий успеха.** Ни одного падения на 10 seed; список исправленных файлов
приложен к коммиту.

### Задача 1.4 — Перевести мутации `Platform` на `jest.replaceProperty`

**Находка.** `tests/mocks/obsidian.ts:1128` экспортирует `Platform` как обычный
объект `{ isMobile: false, isMobileApp: false }`. Тесты присваивают ему напрямую:
**106 упоминаний в 21 файле**. Ни `clearMocks`, ни `restoreMocks` свойства
объекта не восстанавливают — только ручные `afterEach(resetPlatform)`.
Дисциплина в целом соблюдается, но `tests/unit/settingsDefinitions.test.ts:459`
сбрасывает флаг последней строкой **тела теста**: если ассерт выше упадёт, сброс
не выполнится и состояние утечёт в соседние тесты.

`jest.replaceProperty` в проекте не используется ни разу (0 вызовов).

**Действие.** Добавить в `tests/helpers/` хелпер `withPlatform({ isMobile, isMobileApp })`
поверх `jest.replaceProperty`, восстанавливающийся автоматически через
`restoreMocks: true`. Перевести на него все 106 мест. Удалить ручные
`resetPlatform` и связанные `afterEach`.

**Критерий приёмки.**

```bash
grep -rn "Platform\.isMobile\(App\)\? *=" tests --include='*.test.ts' | wc -l   # 0
grep -rc "replaceProperty" tests --include='*.ts' | awk -F: '{s+=$2} END{print s}'  # >= 21
```

**Критерий успеха.** Покрытие `src/platform/` остаётся 100 %; `--randomize`
зелёный; тесты, зависящие от платформы, не требуют ручного сброса.

### Задача 1.5 — Изолировать остальные точки общего мутируемого состояния мока

**Находка.** Помимо `Platform`: `__setRequestUrlHandler` используется в 9 файлах,
`apiVersion` мутируется в `tests/unit/SystemDiagnostics.test.ts`.

**Действие.** Дать каждому из них хелпер с автоматическим восстановлением по
образцу 1.4 (`withRequestUrl(handler)`, `withApiVersion(version)`).

**Критерий приёмки.**

```bash
grep -rn "__setRequestUrlHandler\|apiVersion *=" tests --include='*.test.ts' | wc -l   # 0
```

**Критерий успеха.** Провайдерские тесты (Deepgram, Gemini, Whisper, httpClient,
geminiFileApi) проходят в любом порядке; покрытие `src/transcription/` не ниже
базового.

### Задача 1.6 — Убрать избыточный teardown

**Находка.** В конфиге уже стоят `clearMocks: true` и `restoreMocks: true`, при
этом в тестах: `jest.clearAllMocks()` — **49 вызовов в 43 файлах**,
`jest.restoreAllMocks()` — 3 вызова. Это ~50 строк, вводящих читателя в
заблуждение (создаётся впечатление, что без них сломается).

**Действие.** Удалить все 52 вызова. Там, где после удаления остаётся пустой
`beforeEach`/`afterEach` — удалить и его.

**Критерий приёмки.**

```bash
grep -rc "clearAllMocks\|restoreAllMocks" tests --include='*.test.ts' \
  | awk -F: '{s+=$2} END{print s+0}'   # 0
npm run test:coverage                  # зелёный
npx jest --randomize                   # зелёный
```

**Критерий успеха.** Покрытие не изменилось ни на один файл (проверяется
`coverage-diff.mjs`); число тест-кейсов 2776.

### Задача 1.7 — Включить `--randomize` в CI

**Действие.** Заменить в `.github/workflows/ci.yml` шаг тестов на
`npm run test:coverage -- --randomize`. Seed печатается Jest в отчёте, что
позволяет воспроизвести падение локально.

**Критерий приёмки.** Три последовательных прогона CI зелёные; в логе виден
разный `Seed:`.

**Критерий успеха.** Внесение искусственной зависимости от порядка (например,
возврат мутации прототипа из 1.1) роняет CI в пределах 3 прогонов.

### Критерий завершения этапа 1

- `npx jest --randomize` зелёный на 10 seed.
- Ноль прямых присваиваний общему состоянию мока (`Platform`, `apiVersion`,
  requestUrl-handler, прототипы).
- Ноль избыточных `clearAllMocks` / `restoreAllMocks`.
- CI гоняет тесты в случайном порядке.
- INV-1 … INV-6 соблюдены; покрытие идентично базовому (этап не добавляет и не
  удаляет тестов).

**Риск.** Задача 1.3 может вскрыть больше падений, чем 3. Это не повод
откладывать — каждое такое падение уже существует как латентный баг.
**Откат.** Пофайловый, задачи независимы.

---

## Этап 2. Фундамент: мок Obsidian

**Цель.** Устранить корневую причину дублирования и низкого покрытия
Obsidian-связанного кода — неполноту общего мока.

**Обоснование.**

- Пакет `obsidian@1.13.1` — **только типы** (`"main": ""`, 8482 строки, 102
  класса, 111 интерфейсов, 47 функций). Рантайма нет: мокать модуль — не выбор,
  а единственная возможность.
- Файлы `src`, импортирующие `obsidian`, покрыты на **91.1 %** (72 файла,
  6764 стейтмента), не импортирующие — на **96.1 %** (106 файлов, 4362
  стейтмента). Весь топ провалов — в связанной группе.
- Общий мок покрывает 40 экспортов из ~289 и имеет четыре пробела, каждый из
  которых заставляет тесты обходиться самодельными объектами.

### Задача 2.1 — Реализовать класс `Events` и унаследовать его

**Находка.** В реальном API `Vault extends Events`, `Workspace extends Events`,
`MetadataCache extends Events`. В моке `Events` нет вовсе: ни `on`, ни `off`, ни
`offref`, ни `trigger`. В `src` — 6 вызовов `registerEvent`:

| Файл                                        | Событие                        |
| ------------------------------------------- | ------------------------------ |
| `src/player/EnhancedPlayerRegistrar.ts:183` | `vault.on('rename')`           |
| `src/player/EnhancedPlayerRegistrar.ts:201` | `vault.on('delete')`           |
| `src/ui/ContextMenu.ts:284`                 | `workspace.on(…)`              |
| `src/ui/ContextMenu.ts:307`                 | `workspace.on(…)`              |
| `src/utils/multiWindowDomEvents.ts:79`      | `workspace.on('window-open')`  |
| `src/utils/multiWindowDomEvents.ts:81`      | `workspace.on('window-close')` |

Следствие: `EnhancedPlayerRegistrar` — 73.3 % ветвей (32 непокрытых),
`ContextMenu` — 78.6 % (12 непокрытых).

**Действие.** Добавить в `tests/mocks/obsidian.ts` рабочий `Events` с
`on`/`off`/`offref`/`trigger` и `EventRef`. Унаследовать `Vault`, `Workspace`,
`MetadataCache`. Экспортировать хелпер `emit(target, name, ...args)` для тестов.

**Критерий приёмки.**

```bash
# новый юнит-тест самого мока
npx jest tests/unit/mocks/obsidianEvents.test.ts   # зелёный
```

Тест мока должен покрывать: подписку, отписку через `offref`, множественные
подписчики, порядок вызова, отсутствие вызова после `off`.

**Критерий успеха.** Тест, эмитирующий `vault.trigger('rename', file, oldPath)`,
доводит `EnhancedPlayerRegistrar` до срабатывания обработчика без единого
самодельного `app`-объекта.

### Задача 2.2 — Сделать `Vault` и `Workspace` настраиваемыми

**Находка.** Методы мока — статические заглушки, а не `jest.fn()`:

```ts
getFileByPath(_path: string): TFile | null { return null; }  // всегда null
adapter.read = async () => '';                                // всегда ''
```

Их нельзя ни настроить под сценарий, ни проверить вызов. Прямое следствие:
**44 файла** пишут свой `as unknown as App`, **37 файлов** держат локальный
литерал `vault: { … }`, **6 файлов** переопределяют свой `createFile`/`makeFile`.

**Действие.**

1. Перевести все методы `Vault`, `Vault.adapter`, `Workspace`, `FileManager` на
   `jest.fn()` с разумными дефолтами.
2. Добавить хелпер `seedVault({ files: [{ path, content, mtime, size }] })`,
   наполняющий мок так, что `getFileByPath`, `getAbstractFileByPath`,
   `read`/`readBinary`, `adapter.exists` отвечают согласованно.
3. Добавить `seedWorkspace({ activeFile, activeView })`.

**Критерий приёмки.**

```bash
npx jest tests/unit/mocks/obsidianVault.test.ts    # зелёный
```

Тест мока покрывает: посев файлов, чтение, отсутствующий файл, бинарное чтение,
согласованность `exists`/`read`.

**Критерий успеха.** `createMockApp()` из `tests/helpers/createApp.ts`
переписан поверх нового мока и закрывает все сценарии, ради которых
44 файла делали свои объекты (проверяется на этапе 3).

### Задача 2.3 — Починить `MenuItem.onClick`

**Находка.** В моке:

```ts
onClick(_callback: () => void): this { return this; }   // колбэк выбрасывается
```

Кликнуть пункт контекстного меню через общий мок физически нельзя. Именно
поэтому `tests/unit/ContextMenu.test.ts` делает собственный inline
`jest.mock('obsidian')` — одна из 32 таких подмен.

**Действие.** Сохранять колбэк и все builder-значения (`title`, `icon`,
`section`, `checked`, `disabled`). Дать `Menu` доступ к собранным пунктам и
метод `click(titleOrIndex)`.

**Критерий приёмки.**

```bash
npx jest tests/unit/mocks/obsidianMenu.test.ts     # зелёный
```

Тест покрывает: сбор пунктов, клик по заголовку, клик по индексу, разделители,
неактивные пункты.

**Критерий успеха.** `ContextMenu.test.ts` работает без своего
`jest.mock('obsidian')`, покрытие `src/ui/ContextMenu.ts` не ниже 87.8 %.

### Задача 2.4 — Убрать 32 inline-мока `obsidian`

**Находка.** Общий мок — 1289 строк, подключён через `moduleNameMapper`. Но
**32 файла** делают собственный `jest.mock('obsidian', () => ({ … }))`, а фабрика
в `jest.mock` **перебивает** `moduleNameMapper`. Итог: 32 файла тестируются
против другого, урезанного Obsidian, чем остальные 139. Расхождение поведения
происходит молча.

Сам блок скопирован дословно в 7 файлах:

```ts
Notice: jest.fn(),
MarkdownView: jest.fn(),
normalizePath: (p: string) => p.replace(/\\/g, '/'),
Platform: { isMobile: false, isMobileApp: false },
```

**Действие.** Удалить все 32 inline-мока, опираясь на доработанный общий мок из
2.1–2.3. Там, где нужен именно урезанный вариант, — использовать точечный
`jest.spyOn` поверх общего мока, а не подмену модуля.

**Критерий приёмки.**

```bash
grep -rl "jest.mock('obsidian'" tests --include='*.test.ts' | wc -l   # 0
npm run test:coverage                                                  # зелёный
node scripts/coverage-diff.mjs                                         # exit 0
```

**Критерий успеха.** Единственный источник правды об Obsidian —
`tests/mocks/obsidian.ts`; покрытие ни одного файла не упало.

### Задача 2.5 — Централизовать фабрики моков внутренних модулей

**Находка.** Прологи `jest.mock` продублированы: `src/audio/WavEncoder` (7
файлов), `src/recording/AudioStreamHandler` (6), `src/audio/AudioEncoder` (6).
В `tests/unit/RecordingManager.lifecycle.test.ts` этот пролог занимает строки
22–60 и повторён ещё в шести файлах семейства. Всего по прологам — около 250
строк дубля.

**Действие.** Создать `tests/mocks/modules/` с фабриками
(`wavEncoder.ts`, `audioStreamHandler.ts`, `audioEncoder.ts`,
`monoCaptureBridge.ts`). Подключать одной строкой:

```ts
jest.mock('src/audio/WavEncoder', () =>
	require('../../mocks/modules/wavEncoder'),
);
```

**Критерий приёмки.**

```bash
# ни одна фабрика jest.mock не длиннее 3 строк
node scripts/lint-mock-factories.mjs    # или ручная проверка диффа
grep -c "assembleWavFromPcmSegmentFiles" tests/unit/*.test.ts | grep -v ':0' | wc -l   # <= 1
```

**Критерий успеха.** Суммарно в `tests/unit/RecordingManager.*.test.ts` удалено
не менее 200 строк; покрытие `src/recording/` не ниже 95.1 %.

### Задача 2.6 — Задокументировать границы мока

**Действие.** В шапке `tests/mocks/obsidian.ts` перечислить: какие экспорты
Obsidian смоделированы (сейчас 40 из ~289), какие сознательно не смоделированы и
почему, и правило пополнения («добавляем по факту потребности, с юнит-тестом
самого мока»).

**Критерий приёмки.** Комментарий присутствует и перечисляет актуальный список;
`npm run lint` зелёный.

**Критерий успеха.** Новый разработчик по комментарию понимает, дописывать мок
или выносить логику из-под Obsidian (см. этап 6, подход «extract»).

### Критерий завершения этапа 2

- `grep -rl "jest.mock('obsidian'" tests` → 0.
- Мок поддерживает события, настраиваемый vault/workspace, кликабельное меню.
- Появился каталог `tests/unit/mocks/` с тестами самого мока (минимум 3 файла).
- Удалено не менее 400 строк дубля.
- INV-1 … INV-6 соблюдены; покрытие **не ниже** базового по каждому файлу.

**Риск.** Замена урезанных inline-моков на полный может изменить поведение
тестов (например, `Notice` перестанет быть `jest.fn()` там, где на это
рассчитывали). **Митигация:** задача 2.4 выполняется файл за файлом, каждый —
отдельным коммитом, с прогоном `coverage-diff.mjs`.

---

## Этап 3. Фикстуры, фабрики и устранение дублей

**Цель.** Свести повторяющуюся обвязку к переиспользуемым фабрикам, внедрить
паттерн `createSut`, удалить мёртвый код.

**Обоснование.** Детектор клонов находит **168 уникальных 6-строчных блоков,
повторяющихся в ≥3 файлах**. Инфраструктура хелперов существует (8 файлов,
~1900 строк), но освоена крайне неравномерно.

### Задача 3.1 — Удалить мёртвые хелперы

**Находка.** Ноль внешних использований:
`installMediaRecorderMock`, `installAudioContextMock`, `installGetUserMediaMock`,
`MediaRecorderDouble`, `AudioContextDouble` — около 200 строк в
`tests/helpers/mediaMocks.ts`.

**Действие.** Удалить. Если функциональность нужна — она возвращается через
2.5/3.2 в рабочем виде, а не как неиспользуемый код.

**Критерий приёмки.**

```bash
grep -rn "installMediaRecorderMock\|installAudioContextMock\|installGetUserMediaMock" tests | wc -l   # 0
wc -l tests/helpers/mediaMocks.ts    # уменьшилось не менее чем на 180 строк
```

**Критерий успеха.** Покрытие не изменилось; `npm run typecheck` зелёный.

### Задача 3.2 — Довести `createMockApp` до полного покрытия потребностей

**Находка.** `createMockApp` используется в **3 файлах**, тогда как
`as unknown as App` встречается в **44**. Прочая адаптация хелперов:
`changeSetting` — 1 файл, `capturedSettings`/`settingRow` — 2,
`installSharedAudio` — 2, `makeMarkerStore` — 3, `createMockAudioBuffer` — 4,
`jsonBody` — 5, `createFile` — 6, `defined` — 17. Для контраста: `at()` — 115
файлов, то есть хороший хелпер осваивается охотно.

**Действие.** Собрать реестр того, что 44 файла делают руками, и покрыть это
опциями `createMockApp(overrides)` поверх мока из 2.2. Мигрировать все 44 файла.

**Критерий приёмки.**

```bash
grep -rl "as unknown as App" tests --include='*.test.ts' | wc -l   # <= 2 (обоснованные исключения)
grep -rlE "^\s*vault: *\{" tests --include='*.test.ts' | wc -l     # <= 2
grep -rl "createMockApp" tests --include='*.test.ts' | wc -l       # >= 40
```

**Критерий успеха.** Покрытие не ниже базового; удалено не менее 600 строк.

### Задача 3.3 — Свести дублирующиеся `flush`/`tick`

**Находка.** Девять определений одного и того же: `tests/helpers/playbackHarness.ts:114`
(`tick`, освоен в 2 файлах), `tests/unit/helpers/recordingManagerTestKit.ts:181`
(`flushAsync`), плюс локальные в `AudioPlayer.regression`, `AudioPlayer.decomposition`,
`RecordingManager.markers` (`flushMicrotasks`), `EnhancedPlayerRegistrar` (`flush`),
`SettingsTab` (`flushAsync`), `TranscriptionModalCost` (`flush`),
`RecordingManager.streaming` (`flushMicrotasks`). Дополнительно — **24 голых**
`await new Promise((r) => setTimeout(r, 0))`.

**Действие.** Оставить один экспорт `tick()` в `tests/helpers/`, перевести на
него все 9 мест и 24 голых ожидания. Отдельно рассмотреть реальные задержки с
ненулевым таймаутом (`SplitModal.test.ts:599` — 5 мс,
`EnhancedPlayerRegistrar.test.ts:75` — 120 мс, `TrackWriteQueue.test.ts:96` —
10 мс): заменить на фейковые таймеры там, где это возможно.

**Критерий приёмки.**

```bash
grep -rnE "await new Promise.*setTimeout" tests --include='*.test.ts' | wc -l   # <= 2
grep -rnE "(const|function) (flush|tick|nextTick|flushPromises|flushAsync|flushMicrotasks)" \
  tests --include='*.ts' | wc -l   # 1
```

**Критерий успеха.** Время прогона не выросло; `--randomize` зелёный.

### Задача 3.4 — Внедрить паттерн `createSut`

**Находка.** Паттерн не применяется **ни разу**. Вместо него — связка
`let x; let y; beforeEach(() => { … })`. Самый яркий случай: семейство
`RecordingManager.*` (7 файлов, 4545 строк) с дословно одинаковым `beforeEach`
в 6 файлах; конструктор SUT повторён **30 раз**.

**Действие.** Ввести `createSut(overrides)`, возвращающий SUT и все его
зависимости. Приоритет внедрения:

1. `RecordingManager.*` (6 файлов) — через существующий `recordingManagerTestKit`.
2. Провайдеры транскрипции (общий литерал fake-провайдера продублирован в 7
   файлах: `label: 'Fake'`, `requiresNetwork: false`, `capabilities: {…}`).
3. `SettingsTab` / `settingsDefinitions` — поверх `captureSettings` и
   `declarativeSettings`, которые уже есть, но освоены в 1–2 файлах.

**Критерий приёмки.**

```bash
grep -rc "createSut" tests --include='*.test.ts' | awk -F: '{s+=$2} END{print s}'   # >= 40
# beforeEach в семействе RecordingManager отсутствует или тривиален
grep -c "beforeEach" tests/unit/RecordingManager.*.test.ts
```

**Критерий успеха.** Число уникальных 6-строчных блоков, повторяющихся в ≥3
файлах, снизилось со 168 минимум до 80 (замер тем же скриптом).

### Задача 3.5 — Заменить приведения типов на `jest.mocked`

**Находка.** **301 приведение `as unknown as` в 85 файлах** при том, что
`jest.mocked` используется всего **7 раз**.

**Действие.** Там, где приведение нужно только для доступа к моку, заменить на
`jest.mocked(fn)`. Там, где оно компенсирует неполноту мока, — дополнить мок
(этап 2). Остальное оставить с поясняющим комментарием.

**Критерий приёмки.**

```bash
grep -rc "as unknown as" tests --include='*.test.ts' | awk -F: '{s+=$2} END{print s}'   # <= 150
grep -rc "jest.mocked" tests --include='*.ts' | awk -F: '{s+=$2} END{print s}'          # >= 60
```

**Критерий успеха.** `npm run typecheck` зелёный; ни одного `@ts-expect-error`
не добавлено (сейчас их 0).

### Задача 3.6 — Разбить два теста-монстра

**Находка.** Средний тест — 12.5 строк, длиннее 60 строк всего 10 из 2631. Но
два выбиваются: `Settings.test.ts` — «should preserve all user settings when
fully specified» (141 строка) и `RecordingManager.output.test.ts` — «should keep
the merged file when cleanup of temporary partials fails» (121 строка).

**Действие.** Разбить каждый на несколько тестов с одной причиной падения.
Первый — прямой кандидат в таблицу (см. 4.1).

**Критерий приёмки.**

```bash
node scripts/longest-tests.mjs   # ни одного теста длиннее 80 строк
```

**Критерий успеха.** Покрытие не ниже базового; число тест-кейсов выросло.

### Критерий завершения этапа 3

- Мёртвые хелперы удалены.
- `as unknown as App` — не более 2 обоснованных случаев.
- Один `tick()` на весь сьют.
- `createSut` внедрён минимум в 3 семейства тестов.
- Клонов (6 строк, ≥3 файла) — не более 80 против 168 базовых.
- Суммарно удалено **не менее 1500 строк** тестов при неизменном покрытии.
- INV-1 … INV-6 соблюдены.

**Риск.** Массовая миграция 44 файлов на `createMockApp` — самый объёмный
дифф плана. **Митигация:** мигрировать пачками по 5–8 файлов, каждая пачка —
отдельный коммит с прогоном `coverage-diff.mjs`.

---

## Этап 4. Параметризация

**Цель.** Перевести повторяющиеся по структуре тесты на таблицы, попутно закрыв
недостающие граничные случаи.

**Обоснование.** `it.each`/`test.each` используется в **16 файлах, 31 раз**;
`describe.each` — в 2. При 2631 объявлении тестов это **~1.2 %**. Детектор
находит **54 группы / 300 тестов**: короткие (≤12 строк), вызывающие один и тот
же SUT, отличающиеся только литералами.

### Задача 4.1 — Параметризовать топ-10 групп

**Находка.** Приоритетный список (число тестов в группе):

| Файл                          | Тестов | SUT                            |
| ----------------------------- | ------ | ------------------------------ |
| `Settings.test.ts`            | 18     | `mergeSettings`                |
| `Settings.validation.test.ts` | 13     | `validateSettings` → `toThrow` |
| `TimeUtils.test.ts`           | 10     | `formatTimecode`               |
| `chapterGeneration.test.ts`   | 10     | `parseChapterResponse`         |
| `httpClient.test.ts`          | 9      | `friendlyHttpHint`             |
| `playerStyles.test.ts`        | 9      | `ruleBody`                     |
| `recordingMarkers.test.ts`    | 8      | `computePartPosition`          |
| `PcmStreamRecorder.test.ts`   | 7      | `captureOnce`                  |
| `transcriptionCosts.test.ts`  | 7      | `resolveEnginePricing`         |
| `settingsDefinitions.test.ts` | 6      | `readValue`                    |

**Действие.** Перевести на объектную форму `it.each` (она читается лучше
позиционной при трёх и более параметрах):

```ts
it.each([
	{ name: 'empty audioDeviceId', patch: { audioDeviceId: '' } },
	{ name: 'whitespace audioDeviceId', patch: { audioDeviceId: '   ' } },
	{ name: 'zero sampleRate', patch: { sampleRate: 0 } },
	{ name: 'negative sampleRate', patch: { sampleRate: -1 } },
])('rejects $name', ({ patch }) => {
	expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...patch })).toThrow(
		SettingsValidationError,
	);
});
```

**Критерий приёмки.**

```bash
grep -rl "it.each\|test.each" tests --include='*.test.ts' | wc -l   # >= 26
node scripts/suite-stats.mjs    # tests >= 2776 (INV-3)
```

**Критерий успеха.** Из 10 перечисленных файлов удалено не менее 500 строк;
покрытие каждого файла не ниже базового.

### Задача 4.2 — Параметризовать оставшиеся 44 группы

**Действие.** По тому же принципу. Группы, где параметризация ухудшает
читаемость (разные Act-фазы, разные наборы моков), — оставить как есть с
пометкой в ревью.

**Критерий приёмки.**

```bash
node scripts/param-candidates.mjs   # групп-кандидатов <= 10
```

**Критерий успеха.** Доля параметризованных файлов выросла с 9 % (16/171) до
не менее 35 %.

### Задача 4.3 — Дозаполнить граничные случаи

**Находка.** Таблица делает пробел визуально очевидным. У `validateSettings`
сейчас нет строк на верхнюю границу и на спецсимволы; у `buildMimeType` — на
неизвестный формат; у `computePartPosition` — на нулевую длительность части.

**Действие.** Для каждой таблицы пройти чек-лист: нормальное значение, минимум,
максимум, пусто, неверный формат, ниже минимума, выше максимума, спецсимволы.
Добавить недостающие строки.

**Критерий приёмки.**

```bash
npm run test:coverage
# branches по src/settings/ выросли; глобальные branches >= 85.5 %
```

**Критерий успеха.** Глобальное покрытие ветвей выросло минимум на 0.6 п.п.
относительно базовых 84.90 %.

### Задача 4.4 — Применить `describe.each` к матричным сценариям

**Находка.** `describe.each` используется в 2 файлах. Кандидаты — сценарии,
прогоняемые в матрице «desktop × mobile» (после 1.4 переключение платформы стало
дешёвым) и «формат × канальный режим».

**Действие.** Свести такие матрицы к `describe.each`.

**Критерий приёмки.**

```bash
grep -rl "describe.each" tests --include='*.test.ts' | wc -l   # >= 6
```

**Критерий успеха.** Покрытие `src/platform/`, `src/settings/settingsPerPlatform`
и `src/audio/formatRegistry` не ниже базового при меньшем объёме кода.

### Критерий завершения этапа 4

- Параметризовано не менее 44 из 54 групп.
- Число тест-кейсов ≥ 2776 (INV-3), при этом строк в `tests/` меньше минимум на
  1000 относительно состояния после этапа 3.
- Глобальные branches ≥ 85.5 %.
- INV-1 … INV-6 соблюдены.

**Риск.** Таблица может скрыть, какой именно кейс упал, если имя строки
неинформативно. **Митигация:** обязательное поле `name` и шаблон `'$name'` в
заголовке.

---

## Этап 5. Слои: unit / integration / e2e

**Цель.** Привести структуру в соответствие с содержанием и завести отдельные
пороги покрытия на слой через `jest.projects`.

**Обоснование.** Формально пирамида правильной формы (164 / 7 / 0), но
классификация не соответствует содержанию.

| Слой                | Файлов | Ср. импортов из `src` | Ср. кейсов | Ср. строк |
| ------------------- | ------ | --------------------- | ---------- | --------- |
| `tests/unit`        | 164    | 3.0                   | 15.6       | 337       |
| `tests/integration` | 7      | 6.0                   | 9.4        | 422       |
| `tests/e2e`         | 0      | —                     | —          | —         |

`jest.projects` в конфиге — пустой массив, возможность не используется.

### Задача 5.1 — Завести три проекта Jest

**Действие.** Перевести конфиг на `projects` с общей базой и тремя записями:
`unit`, `integration`, `e2e`. У каждого — свой `testMatch`, свой `setupFiles` и
**свой `coverageThreshold`**.

**Критерий приёмки.**

```bash
npx jest --selectProjects unit         # зелёный
npx jest --selectProjects integration  # зелёный
npm run test:coverage                  # общий отчёт по трём проектам
```

**Критерий успеха.** `npx jest --showConfig` показывает три проекта; общее
покрытие не ниже базового.

### Задача 5.2 — Перенести 33 неверно классифицированных файла

**Находка.** Файлы в `tests/unit`, тянущие ≥5 модулей из `src`:

| Импортов | Кейсов | Строк | Файл                                      |
| -------- | ------ | ----- | ----------------------------------------- |
| 11       | 36     | 994   | `EnhancedPlayerRegistrar.test.ts`         |
| 10       | 26     | 321   | `transcriptionCore.test.ts`               |
| 10       | 13     | 249   | `transcriptionEngines.test.ts`            |
| 10       | 10     | 438   | `transcriptionServiceAdvanced.test.ts`    |
| 9        | 23     | 547   | `advancedContextPipeline.test.ts`         |
| 9        | 17     | 558   | `transcriptionSidecarIntegration.test.ts` |
| 9        | 9      | 195   | `llmJobEngines.test.ts`                   |
| 8        | 13     | 369   | `AutoChapterService.test.ts`              |
| 8        | 10     | 367   | `AutoChapterServiceProbe.test.ts`         |
| 7        | 35     | 623   | `PartRotationController.test.ts`          |
| 7        | 16     | 424   | `TranscriptionModalCost.test.ts`          |
| 7        | 15     | 323   | `ChapterGenerationModal.test.ts`          |
| 7        | 14     | 185   | `providerCapabilities.test.ts`            |
| 7        | 9      | 251   | `registerActionCommands.test.ts`          |
| 7        | 8      | 463   | `transcriptionServicePartFailure.test.ts` |
| 7        | 8      | 154   | `llmVendors.test.ts`                      |
| 6        | 89     | 1773  | `settingsDefinitions.test.ts`             |
| 6        | 39     | 1110  | `SplitModal.test.ts`                      |
| 6        | 35     | 1090  | `SpeakerRenameModal.test.ts`              |
| 6        | 25     | 855   | `ContextMenu.test.ts`                     |
| 6        | 18     | 196   | `profiles.test.ts`                        |
| 6        | 14     | 308   | `transcriptionDiarizeGating.test.ts`      |
| 6        | 10     | 242   | `llmStep.test.ts`                         |
| 6        | 9      | 221   | `transcriptionServiceCost.test.ts`        |
| 5        | 36     | 1089  | `main.test.ts`                            |
| 5        | 25     | 700   | `RecordingFinalizer.test.ts`              |
| 5        | 23     | 498   | `SystemDiagnostics.test.ts`               |
| 5        | 20     | 293   | `audioPrep.test.ts`                       |
| 5        | 11     | 262   | `audioChunksEncoding.test.ts`             |
| 5        | 9      | 354   | `RecordingManager.fallback.test.ts`       |
| 5        | 5      | 316   | `providerAdvancedBias.test.ts`            |
| 5        | 5      | 154   | `transcriptionEngineSection.test.ts`      |
| 5        | 4      | 162   | `transcriptionServiceCancel.test.ts`      |

Обратно: `tests/integration/PopoutPlayback.test.ts` тянет 2 модуля — это юнит.

**Действие.** Переместить по критерию «≥5 модулей из `src` или требует реального
взаимодействия компонентов». Спорные случаи разрешать в пользу более низкого
слоя, если тест можно свести к ≤3 импортам после этапа 3.

**Критерий приёмки.**

```bash
node scripts/layer-check.mjs
# unit: ни одного файла с >4 импортами из src
# integration: ни одного файла с <3 импортами из src
```

**Критерий успеха.** Соотношение слоёв — примерно 130 unit / 40 integration /
5–8 e2e; общее покрытие не ниже базового.

### Задача 5.3 — Создать слой e2e внутри jsdom

**Находка.** Все 7 интеграционных тестов — про плеер и спикеров. Сквозного пути
«запись → сохранение → транскрибация» нет ни на одном слое. Прямое следствие —
`src/main.ts`: 84 непокрытых стейтмента, **34 непокрытых функции (50.7 %)**,
37 непокрытых ветвей.

Настоящий e2e через `wdio-obsidian-service` (v3.2.0, живой, обновлён 2026-08-17)
в этот план **не входит**: ключевые сценарии плагина — микрофон, `MediaRecorder`,
`AudioContext` — в headless-CI недоступны, поэтому такой e2e покрыл бы только
UI-обвязку, которая дешевле закрывается в jsdom. Вернуться к вопросу — если
появятся регрессии, воспроизводимые только в живом Obsidian.

**Действие.** Создать `tests/e2e/` с 5–8 сценариями полного жизненного цикла
плагина, каждый — от `onload` до `onunload`:

1. `pluginLifecycle.e2e.test.ts` — загрузка, регистрация команд, ribbon, статус-бар, выгрузка.
2. `recordToNote.e2e.test.ts` — запись → финализация → вставка ссылки в заметку.
3. `recordThenTranscribe.e2e.test.ts` — запись → авто-транскрибация → запись результата.
4. `recoveryOnStartup.e2e.test.ts` — незавершённая сессия в журнале → модалка восстановления → recover/discard.
5. `convertAndReembed.e2e.test.ts` — конвертация файла → перезапись ссылки → enhanced-плеер.
6. `markersDuringRecording.e2e.test.ts` — команда маркера → модалка → сохранение в sidecar.
7. `mobileDegradation.e2e.test.ts` — тот же путь при `Platform.isMobile` (через хелпер из 1.4).

**Критерий приёмки.**

```bash
npx jest --selectProjects e2e     # зелёный, >= 5 файлов
npm run test:coverage
node -e "const s=require('./coverage/coverage-summary.json'); \
  const m=s[process.cwd()+'/src/main.ts']; console.log(m.functions.pct)"
# >= 90
```

**Критерий успеха.** `src/main.ts` — функции ≥ 90 % (базово 50.7 %), стейтменты
≥ 90 % (базово 73.6 %); каталог `src/` в целом ≥ 90 % стейтментов (базово 82.6 %).

### Задача 5.4 — Пороги на слой

**Действие.** В `projects` задать: unit — самый высокий порог (он покрывает
чистую логику), integration — средний, e2e — низкий по покрытию, но с
обязательным списком сценариев.

**Критерий приёмки.** Удаление любого e2e-сценария роняет CI по порогу проекта
`e2e` или по `coverage-diff.mjs`.

**Критерий успеха.** Каждый слой защищён отдельно; деградация одного не
маскируется ростом другого.

### Критерий завершения этапа 5

- Три проекта Jest с раздельными порогами.
- Ноль неверно классифицированных файлов по `layer-check.mjs`.
- 5–8 e2e-сценариев, `src/main.ts` — функции ≥ 90 %.
- INV-1 … INV-6 соблюдены.

**Риск.** Переход на `projects` меняет разрешение `moduleNameMapper` и
`setupFiles` — возможны неожиданные падения. **Митигация:** 5.1 выполняется и
проверяется до любых перемещений файлов (5.2).

---

## Этап 6. Закрытие покрытия

**Цель.** Довести оставшиеся провалы, применяя рекомендацию сообщества Obsidian:
где возможно — не мокать, а выносить логику из-под Obsidian API.

**Обоснование.** Официальной документации по тестированию плагинов у Obsidian
нет; гайд Obsidian Hub рекомендует Extract Method — выносить бизнес-логику в
функции, не зависящие от `obsidian`. Замер по этому проекту подтверждает
эффективность: чистые файлы покрыты на 96.1 %, связанные — на 91.1 %.

### Задача 6.1 — `src/player/WaveformController.ts` (58.3 % → ≥ 95 %)

**Находка.** Худший файл по существу: 26 непокрытых ветвей из 36 (**27.8 %**),
7 непокрытых функций. Не покрыт весь конвейер построения волны — строки 169–250:
`vault.readBinary` → `decoder.decode` → `computeWaveformPeaksProgressive` →
кэш → `applyPeaks`, включая ветки «хост выгружен» (4 проверки), попадание в кэш,
`catch` с `console.warn`, и `redrawWhenSized` с ретраями через
`requestAnimationFrame` (в jsdom `clientWidth` всегда 0, поэтому путь никогда не
исполнялся). Своего тест-файла у модуля нет.

**Действие.**

1. Вынести чистую часть конвейера (каналы → пики → нормализация → кэш-ключ) в
   отдельный модуль без импорта `obsidian` и покрыть таблицей.
2. Оставшуюся Obsidian-часть покрыть через настраиваемый vault из 2.2.
3. `redrawWhenSized` покрыть, задав `clientWidth` через
   `Object.defineProperty` и фейковый `requestAnimationFrame`.

**Критерий приёмки.**

```bash
npx jest tests/unit/WaveformController.test.ts --coverage \
  --collectCoverageFrom='src/player/WaveformController.ts'
# statements >= 95, branches >= 90
```

**Критерий успеха.** Все четыре проверки «хост выгружен», путь кэш-хита и
`catch` покрыты явными тестами.

### Задача 6.2 — `src/player/AudioPlayer.ts` (76.7 % → ≥ 95 %)

**Находка.** 75 непокрытых стейтментов, 31 непокрытая ветвь, 28 непокрытых
функций. Конкретно: `renderNativeFallback` (деградация при падении
enhanced-рендера, строки 294–307), ожидание загрузки embed через
`MutationObserver` + таймаут (336–361), меню скорости воспроизведения (976–999),
`copy timestamp link` — и успех, и `catch` буфера обмена (1068–1083).

**Действие.** Покрыть каждый путь отдельным тестом; меню скорости — таблицей по
`PLAYER_PLAYBACK_RATE_PRESETS`; clipboard — через мок `navigator.clipboard` с
успехом и отказом.

**Критерий приёмки.** statements ≥ 95, branches ≥ 88, functions ≥ 92 по файлу.

**Критерий успеха.** `renderNativeFallback` покрыт тестом, который роняет
enhanced-рендер и проверяет, что в контейнере появился рабочий `<audio controls>`.

### Задача 6.3 — `src/ui/ModelIdModal.ts` (18.2 % → ≥ 95 %)

**Находка.** Покрыт только импорт: **0 % функций (7 из 7 непокрыты)**, 0 %
ветвей, 18 непокрытых стейтментов из 22. Тестов нет вообще. Самая дешёвая
победа: поведение простое — валидация id через `normalizeModelId`, включение и
отключение кнопки Add, `close()` + колбэк.

**Действие.** Создать `tests/unit/ModelIdModal.test.ts`: пустой ввод, пробелы,
валидный id, повторное отключение кнопки после очистки, Cancel, Add.

**Критерий приёмки.** statements ≥ 95, functions 100 % по файлу.

**Критерий успеха.** Ни один путь модалки не остаётся без теста.

### Задача 6.4 — `src/actions/fileActions.ts` (79.4 % → ≥ 95 %)

**Находка.** 100 % ветвей, но **57.1 % функций** — не покрыты именно `run()`
шести действий (открытие модалок): convert, split, cleanup, transcribe, rename
speakers, generate chapters.

**Действие.** Один тест-файл со шпионами на конструкторы модалок; проверять, что
`run()` открывает правильную модалку с правильными аргументами. Хорошо ложится
в `it.each` по реестру действий.

**Критерий приёмки.** functions 100 %, statements ≥ 95 по файлу.

**Критерий успеха.** Добавление нового действия в реестр без теста роняет
таблицу (тест проверяет полноту реестра).

### Задача 6.5 — `src/ui/ConversionModal.ts` (77.5 % → ≥ 95 %)

**Находка.** **50 % функций (11 из 22)** — не покрыты колбэки `onChange`
дропдаунов (формат, каналы, битрейт, удаление источника, действие со ссылками) и
`onClick` кнопки Convert с её `setDisabled`/`finally`.

**Действие.** Покрыть через `captureSettings` (хелпер уже есть, освоен в 2
файлах); каналы и форматы — таблицей по `CHANNEL_MODES`.

**Критерий приёмки.** functions ≥ 92, statements ≥ 95 по файлу.

### Задача 6.6 — `src/recording/InputLevelMonitor.ts` (80 % → ≥ 95 %)

**Находка.** 57.1 % ветвей, 57.1 % функций. Не покрыты: `catch` при отказе
`AudioContext`, ветка `state === 'suspended'` → `resume()`, `getLevel()`.

**Действие.** Покрыть через мок `AudioContext` (возвращается из 3.1 в рабочем
виде); три сценария: успешный старт, suspended → resume, конструктор бросает.

**Критерий приёмки.** branches ≥ 90, functions 100 % по файлу.

### Задача 6.7 — `src/player/views/WaveformCanvas.ts` (74.6 % → ≥ 92 %)

**Находка.** 65.4 % ветвей; не покрыты строки 171–187 — путь отрисовки при
нулевой ширине канваса (в jsdom `clientWidth` всегда 0).

**Действие.** Мок 2D-контекста + подмена `clientWidth`/`clientHeight` через
`Object.defineProperty`.

**Критерий приёмки.** statements ≥ 92, branches ≥ 85 по файлу.

### Задача 6.8 — Остальные адресные провалы

**Находка.** Оставшиеся файлы с заметным объёмом непокрытого:

| Файл                                        | stmt % | Непокрыто | Основное содержание пробела             |
| ------------------------------------------- | ------ | --------- | --------------------------------------- |
| `src/settings/SettingsTab.ts`               | 86.6   | 43        | 32 ветви, 17 функций                    |
| `src/ui/TranscriptionModal.ts`              | 88.7   | 37        | 29 ветвей, 21 функция                   |
| `src/player/EnhancedPlayerRegistrar.ts`     | 85.2   | 35        | 32 ветви — закрываются событиями из 2.1 |
| `src/recording/RecordingManager.ts`         | 95.1   | 24        | 21 ветвь, 10 функций                    |
| `src/ui/StatusBar.ts`                       | 87.1   | 22        | 16 ветвей                               |
| `src/player/views/MarkerListView.ts`        | 84.9   | 18        | 20 ветвей (65.5 %)                      |
| `src/recording/AudioStreamHandler.ts`       | 83.5   | 18        | 15 ветвей                               |
| `src/chapters/transcriptSources.ts`         | 91.3   | 16        | 21 ветвь                                |
| `src/audio/AudioFormatConverter.ts`         | 82.1   | 15        | 15 ветвей (65.9 %)                      |
| `src/transcription/TranscriptionService.ts` | 93.0   | 15        | 28 ветвей                               |
| `src/ui/SpeakerRenameModal.ts`              | 92.7   | 15        | 21 ветвь                                |
| `src/player/SeekController.ts`              | 83.3   | 9         | 64 % ветвей                             |
| `src/audio/encodingWorker.ts`               | 76.9   | 3         | 3 стейтмента                            |

**Действие.** Закрывать по убыванию непокрытых **ветвей**, а не стейтментов —
ветви сейчас самая слабая метрика (84.90 % при 90.49 % функций).

**Критерий приёмки.** Каждый файл из таблицы — не ниже 92 % стейтментов и 85 %
ветвей.

**Критерий успеха.** Глобально: statements ≥ 96 %, branches ≥ 90 %,
functions ≥ 95 %, lines ≥ 96 %.

### Задача 6.9 — Поднять пороги до нового факта

**Действие.** После 6.1–6.8 обновить глобальные и per-directory пороги до
достигнутых значений минус 0.5 п.п. Обновить `tests/coverage-baseline.json`
через `--update-baseline`.

**Критерий приёмки.** `npm run test:coverage` зелёный на новых порогах;
`coverage-diff.mjs` показывает нулевую регрессию.

**Критерий успеха.** Новый запас до порога — не более 0.5 п.п. по каждой метрике.

### Критерий завершения этапа 6

- Ни одного файла `src/**` ниже 90 % стейтментов.
- Глобально: statements ≥ 96 %, branches ≥ 90 %, functions ≥ 95 %, lines ≥ 96 %.
- Пороги подняты до нового факта.
- INV-1 … INV-6 соблюдены.

---

## Этап 7. Закрепление

**Цель.** Сделать так, чтобы достигнутое состояние не деградировало
автоматически, а не за счёт дисциплины ревьюера.

### Задача 7.1 — Подключить `eslint-plugin-jest`

**Находка.** Плагин не установлен. В `eslint.config.mjs` для `tests/**` заданы
только послабления (`unbound-method`, `require`).

**Действие.** Установить `eslint-plugin-jest@29.16.1`, включить для `tests/**`:
`no-focused-tests` (error), `no-disabled-tests` (error), `expect-expect` (error),
`no-conditional-expect` (error), `valid-expect` (error),
`no-standalone-expect` (error), `prefer-each` (warn),
`no-identical-title` (error), `require-top-level-describe` (warn).

`prefer-each` важен отдельно: он автоматически подсвечивает регресс этапа 4.

**Критерий приёмки.**

```bash
npm run lint     # зелёный
# добавить it.only в любой файл:
npm run lint     # красный на no-focused-tests
```

**Критерий успеха.** Правила стоят на `error`, а не `warn` (кроме двух
перечисленных); CI падает при их нарушении.

### Задача 7.2 — Доменные матчеры вместо селекторов

**Находка.** `expect.extend` не используется ни разу. При этом в тестах
**263 `querySelector`**, из них **76 по классу `.aar-*`**, и 141 сравнение
`textContent`. Переименование CSS-класса красит тесты в красный, хотя поведение
не менялось.

**Действие.** Ввести матчеры в `tests/helpers/matchers.ts`:
`toHaveControl(name)`, `toShowTime(text)`, `toHaveMarkerAt(seconds)`,
`toBeDisabledControl()`. Селекторы держать в одном модуле
`tests/helpers/selectors.ts`.

**Критерий приёмки.**

```bash
grep -rc "querySelector" tests --include='*.test.ts' | awk -F: '{s+=$2} END{print s}'  # <= 120
grep -rn "'\.aar-" tests --include='*.test.ts' | wc -l                                  # <= 10
```

**Критерий успеха.** Переименование любого CSS-класса требует правки одного
файла `selectors.ts`, а не 76 мест.

### Задача 7.3 — Унифицировать именование тестов

**Находка.** Две конкурирующие конвенции: **652** заголовка начинаются со
`should`, **675** — с глагола 3-го лица (`returns`, `throws`, `keeps`).
Расплывчатых заголовков мало — 11 из 2631, это не проблема.

**Действие.** Принять третье лицо (короче, читается как контракт), переписать
652 заголовка со `should`. Зафиксировать правило в документе из 7.4 и, если
получится, в ESLint через `jest/valid-title` с регулярным выражением.

**Критерий приёмки.**

```bash
grep -rhoE "^\s*(it|test)\(\s*['\"\`]should " tests --include='*.test.ts' | wc -l   # 0
```

**Критерий успеха.** `npm run lint` падает на заголовке, начинающемся со
`should`.

### Задача 7.4 — Написать `docs/dev/testing.md`

**Находка.** Ни `CONTRIBUTING`, ни описания слоёв не существует — отсюда и
расползание unit/integration, и две конвенции именования. Каталог `docs/` —
публикуемая пользовательская документация (линкуется из README и из настроек
плагина), поэтому dev-документ кладётся в подкаталог `docs/dev/`, не включённый
в `docs/index.md`.

**Действие.** Документ должен содержать:

1. Три слоя и критерий отнесения (порог по числу импортов из `src`).
2. Структуру теста: Arrange / Act / Assert.
3. `createSut` вместо `beforeEach` с общим состоянием.
4. Именование: третье лицо, контракт в заголовке.
5. Моки только на границах (сеть, файловая система, время, случайность,
   Obsidian API); свои чистые функции — без моков.
6. Таблицы `it.each` при трёх и более однотипных случаях; объектная форма.
7. Чек-лист граничных случаев.
8. Запрет мутировать общее состояние без `jest.replaceProperty`/`jest.spyOn`.
9. Правило пополнения мока Obsidian и когда вместо этого выносить логику.
10. Как читать `coverage-diff.mjs` и что делать при регрессии.

**Критерий приёмки.** Документ существует, все 10 разделов заполнены, ссылки на
реальные файлы-примеры в репозитории проверены.

**Критерий успеха.** Новый тест, написанный по документу, проходит ревью без
замечаний по стилю.

### Задача 7.5 — Финальная фиксация порогов и baseline

**Действие.** Обновить `tests/coverage-baseline.json` и пороги до финального
факта. Зафиксировать в CI полный набор: build → lint → typecheck →
test:coverage --randomize → coverage-diff → suite-stats.

**Критерий приёмки.** Все шесть шагов CI зелёные на трёх последовательных
прогонах.

**Критерий успеха.** Любая из шести регрессий (типы, стиль, покрытие глобально,
покрытие пофайлово, порядок тестов, число тестов) роняет CI на своём шаге.

### Задача 7.6 — Опционально: type-тесты

**Находка.** Type-тестов нет; в Jest для них нужен внешний пакет
(`expect-type@1.4.0`).

**Действие.** Подключить `expect-type` и покрыть generic-API:
`src/settings/settingsSerialization.ts` (139 стейтментов),
`src/providers/providers.ts` (91).

**Критерий приёмки.** `npm run typecheck` включает проверку type-тестов; заведомо
неверный тип роняет её.

**Критерий успеха.** Изменение сигнатуры `mergeSettings` без обновления
type-теста роняет typecheck.

### Критерий завершения этапа 7

- `eslint-plugin-jest` с правилами на `error`.
- Доменные матчеры; `querySelector` ≤ 120, `.aar-` ≤ 10.
- Единая конвенция именования, проверяемая линтером.
- `docs/dev/testing.md` со всеми 10 разделами.
- CI из шести защитных шагов.

---

## 2. Трассируемость: находка → задача

| Находка                                           | Величина                                                                                                           | Задача             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Запас до порога всего 228 стейтментов             | 773 непокрыто при лимите 1001                                                                                      | 0.1                |
| Локальный порог только на `src/platform/` (100 %) | 5 слабых каталогов без защиты                                                                                      | 0.2                |
| Нет пофайловой защиты покрытия                    | —                                                                                                                  | 0.3, 0.4           |
| Тесты зависят от порядка                          | 3 падения при `--randomize`                                                                                        | 1.1, 1.2, 1.3, 1.7 |
| Мутация прототипа без восстановления              | 1 место                                                                                                            | 1.1                |
| Общий мутируемый `Platform`                       | 106 упоминаний в 21 файле                                                                                          | 1.4                |
| Сброс в теле теста (утечка при падении)           | `settingsDefinitions.test.ts:459`                                                                                  | 1.4                |
| Прочее общее состояние мока                       | `__setRequestUrlHandler` в 9 файлах, `apiVersion`                                                                  | 1.5                |
| Избыточный teardown                               | 49 `clearAllMocks` + 3 `restoreAllMocks`                                                                           | 1.6                |
| Нет `Events` в моке                               | 6 `registerEvent` в `src`                                                                                          | 2.1                |
| `Vault` — статические заглушки                    | 44 самодельных `App`                                                                                               | 2.2, 3.2           |
| `MenuItem.onClick` выбрасывает колбэк             | —                                                                                                                  | 2.3                |
| Два конкурирующих мока Obsidian                   | 32 inline против 1 общего                                                                                          | 2.4                |
| Дублирующиеся прологи `jest.mock`                 | ~250 строк в 6–7 файлах                                                                                            | 2.5                |
| Мёртвые хелперы                                   | 3 функции + 2 типа, ~200 строк                                                                                     | 3.1                |
| Низкая адаптация хелперов                         | `createMockApp` — 3 файла из 44 нуждающихся                                                                        | 3.2                |
| Дублирующиеся `flush`/`tick`                      | 9 определений + 24 голых ожидания                                                                                  | 3.3                |
| Нет паттерна `createSut`                          | 0 применений; SUT-конструктор ×30                                                                                  | 3.4                |
| Дубли блоков                                      | 168 блоков по 6 строк в ≥3 файлах                                                                                  | 3.1–3.4            |
| Приведения типов                                  | 301 `as unknown as`; `jest.mocked` — 7                                                                             | 3.5                |
| Тесты-монстры                                     | 141 и 121 строка                                                                                                   | 3.6                |
| Низкая параметризация                             | 31 сайт на 2631 тест (1.2 %)                                                                                       | 4.1, 4.2, 4.4      |
| Кандидаты в таблицы                               | 54 группы / 300 тестов                                                                                             | 4.1, 4.2           |
| Недостающие граничные случаи                      | branches 84.90 % — слабейшая метрика                                                                               | 4.3                |
| `jest.projects` не используется                   | `projects: []`                                                                                                     | 5.1, 5.4           |
| Неверная классификация слоёв                      | 33 unit-файла с ≥5 импортами                                                                                       | 5.2                |
| Нет слоя e2e и сквозных сценариев                 | 164 / 7 / 0                                                                                                        | 5.3                |
| `main.ts` — функции 50.7 %                        | 34 непокрытых функции                                                                                              | 5.3                |
| `WaveformController` — ветви 27.8 %               | 26 непокрытых ветвей                                                                                               | 6.1                |
| `AudioPlayer` — 76.7 %                            | 75 стейтментов, 28 функций                                                                                         | 6.2                |
| `ModelIdModal` — функции 0 %                      | тестов нет вовсе                                                                                                   | 6.3                |
| `fileActions` — функции 57.1 %                    | 6 непокрытых `run()`                                                                                               | 6.4                |
| `ConversionModal` — функции 50 %                  | 11 из 22                                                                                                           | 6.5                |
| `InputLevelMonitor` — ветви 57.1 %                | —                                                                                                                  | 6.6                |
| `WaveformCanvas` — 74.6 %                         | jsdom `clientWidth` = 0                                                                                            | 6.7                |
| Прочие 13 файлов ниже 92 %                        | см. таблицу 6.8                                                                                                    | 6.8                |
| Нет `eslint-plugin-jest`                          | 0 правил для тестов                                                                                                | 7.1                |
| `expect.extend` не используется                   | 263 `querySelector`, 76 по `.aar-`                                                                                 | 7.2                |
| Две конвенции именования                          | 652 `should` против 675 в 3-м лице                                                                                 | 7.3                |
| Нет документа с конвенциями                       | —                                                                                                                  | 7.4                |
| Нет type-тестов                                   | —                                                                                                                  | 7.6                |
| Обсуждено и сознательно отклонено                 | миграция на Vitest; e2e через `wdio-obsidian-service`; `jest-environment-obsidian` (v0.0.1, заброшен с 2023-04-14) | см. раздел 4       |

## 3. Целевые метрики

| Показатель                     | База        | После этапа 4 | После этапа 6    | После этапа 7    |
| ------------------------------ | ----------- | ------------- | ---------------- | ---------------- |
| Statements                     | 93.05 %     | 93.05 %       | ≥ 96 %           | ≥ 96 %           |
| Branches                       | 84.90 %     | ≥ 85.5 %      | ≥ 90 %           | ≥ 90 %           |
| Functions                      | 90.49 %     | 90.49 %       | ≥ 95 %           | ≥ 95 %           |
| Lines                          | 93.06 %     | 93.06 %       | ≥ 96 %           | ≥ 96 %           |
| Тест-кейсов                    | 2776        | ≥ 2776        | ≥ 2900           | ≥ 2900           |
| Строк в тест-файлах            | 58 113      | ≤ 55 500      | ≤ 58 000         | ≤ 58 000         |
| Файлов с `it.each`             | 16          | ≥ 60          | ≥ 60             | ≥ 60             |
| Клонов (6 строк, ≥3 файла)     | 168         | ≤ 80          | ≤ 80             | ≤ 60             |
| inline `jest.mock('obsidian')` | 32          | 0             | 0                | 0                |
| `as unknown as`                | 301         | ≤ 150         | ≤ 150            | ≤ 150            |
| unit / integration / e2e       | 164 / 7 / 0 | 164 / 7 / 0   | ~130 / ~40 / 5–8 | ~130 / ~40 / 5–8 |
| Защитных шагов CI              | 3           | 5             | 6                | 6                |

Пояснение к строке «Строк в тест-файлах»: этапы 2–4 сокращают объём, этап 6
добавляет новые тесты. Итог примерно равен базовому при существенно большем
покрытии и меньшем дублировании.

## 4. Решения, принятые сознательно

**Не мигрировать на Vitest.** Сборка проекта — на esbuild, Vite отсутствует,
поэтому обычный довод «раз уже Vite — берём Vitest» здесь неприменим. Прогон
занимает 23 с, боли нет. Миграция потребовала бы правки 171 файла
(`jest.fn` → `vi.fn`, 150 `jest.mock`, `jest.SpyInstance` → `MockInstance`) и
переписывания `moduleNameMapper` в `alias`. При этом ни одна проблема из
разделов выше не решается сменой раннера — все они структурные. После этапов 2–3
миграция станет существенно дешевле; оценивать её заново имеет смысл тогда.

**Не подключать `jest-environment-obsidian`.** Версия 0.0.1, последняя
публикация 2023-04-14. Против Jest 30 и Obsidian 1.13 не годится.

**Не подключать `wdio-obsidian-service` сейчас.** Пакет живой (3.2.0, публикация
2026-08-17) и является единственным способом настоящего e2e, но ключевые
сценарии плагина — микрофон, `MediaRecorder`, `AudioContext` — в headless-CI
недоступны. Покрыл бы только UI-обвязку, которая дешевле закрывается в jsdom
(задача 5.3).

**Не трогать производительность прогона.** 23 с — не проблема. Рычаги
(`transpilation: true` в ts-jest, `@swc/jest`, `workerThreads: true`,
`--shard`) остаются в резерве, если время начнёт расти.

**Сохранить `coverageProvider: babel`.** V8-провайдер быстрее, но менее точен в
связке с ts-jest.

## 5. Порядок и зависимости

```
Этап 0  Защитный контур          — без зависимостей, делается первым
   |
Этап 1  Изоляция тестов          — требует 0 (иначе регрессия не видна)
   |
Этап 2  Мок Obsidian             — требует 1 (иначе падения не диагностируются)
   |
Этап 3  Фикстуры и дедупликация  — требует 2 (мок должен уметь то, что заменяет)
   |
Этап 4  Параметризация           — требует 3 (таблицы строятся поверх фабрик)
   |
Этап 5  Слои                     — требует 3; 5.1 строго до 5.2
   |
Этап 6  Закрытие покрытия        — требует 2 (события) и 5 (e2e для main.ts)
   |
Этап 7  Закрепление              — требует 4 (prefer-each) и 6 (финальные пороги)
```

Этапы 0 и 1 обязательны к выполнению первыми и целиком. Остальные допускают
частичное исполнение: внутри этапа задачи по большей части независимы, кроме
явно указанных связок (5.1 → 5.2, 6.1–6.8 → 6.9).
