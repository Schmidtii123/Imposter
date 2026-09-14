# Hvem er imposter?

En dansk webapp med to imposter-spil til én fælles telefon. Appen er bygget med React, TypeScript og Vite og kan spilles uden konto eller backend.

## Start lokalt

```bash
npm install
npm run dev
```

Åbn adressen, som Vite viser i terminalen. Hvis andre på samme netværk skal åbne appen, kan de bruge netværksadressen. Til denne version sender spillerne dog én telefon rundt.

## Byg

```bash
npm run build
```

Den færdige statiske app ligger i `dist/` og kan hostes på en almindelig statisk webhost. Appen bruger kun browserens `localStorage` til at holde styr på, hvilke indbyggede kort der allerede er brugt. Runden og eventuelt egen indtastning gemmes ikke.

## Regler

- 3–12 spillere. Én imposter ved 3–5 spillere; fra 6 spillere foreslås to, men værten kan vælge én.
- I ordspillet ser de gode ordet. Impostere kan få et hint, intet ord eller kun et hint, hvis den pågældende imposter er valgt som startspiller.
- I spørgsmålsspillet svarer alle skriftligt. Impostere får et andet spørgsmål uden at få deres rolle at vide.
- Gruppen vælger samlet lige så mange mistænkte, som der er impostere. De gode vinder kun, hvis alle impostere er udpeget.
- Når alle stemmer er valgt, erstatter et klik på en anden spiller det ældste valg.
- Ved egne kort er den, der skriver kortet, spilleder og deltager ikke i den runde.
