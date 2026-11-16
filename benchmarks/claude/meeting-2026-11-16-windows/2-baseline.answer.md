Kävin dokumentaation läpi. Tässä vastaus.

## Lyhyt vastaus

**Ei takaa.** PDB, jossa `minAvailable: 5`, rajoittaa vain vapaaehtoisia häiriöitä, jotka kulkevat Eviction API:n kautta. Kolmesta kysytystä tilanteesta se koskee käytännössä vain drainia:

| Tilanne | Pitääkö PDB viisi replikaa? | Mitä tapahtuu kuudella replikalla |
|---|---|---|
| Deploymentin rolling update (`maxUnavailable: 2`) | **Ei.** Rolling update ei ole PDB:n rajoittama. | Saatavilla voi olla vain **4** replikaa (6 − 2) |
| `kubectl drain` | **Kyllä, ehdoin** | Häätöjä tehdään yksi kerrallaan, eli 6 − 5 = 1 |
| Odottamaton solmuvika | **Ei** | Saatavilla voi olla alle 5, ja alle 4, jos vika osuu rolloutin aikana |

## Dokumentoidut takuut ja rajaukset

**Rolling update**
- Rolloutin poistamat tai saatavilta pois ottamat Podit lasketaan PDB:n budjettiin. Deployment ja StatefulSet eivät kuitenkaan ole PDB:n rajoittamia rolling updatessa, vaan päivityksen käytös määritetään työkuorman omassa specissä (`disruptions.md:133-136`).
- `maxUnavailable` kertoo, montako Podia saa päivityksen aikana olla poissa käytöstä. Prosenttiarvo pyöristetään alaspäin, ja oletus on 25 % (`deployment.md:1191-1194`). Esimerkissä arvo 30 % tarkoittaa, että saatavilla on aina vähintään 70 % (`deployment.md:1196-1199`). Teidän arvoillanne alaraja on siis **4**, ei 5.

**Drain**
- PDB rajoittaa samanaikaisia vapaaehtoisia häiriöitä (`disruptions.md:99-101`). `kubectl drain` käyttää Eviction API:a ja yrittää hylättyjä häätöjä uudelleen, kunnes ne onnistuvat tai aikakatkaisu täyttyy (`disruptions.md:111-116`).
- Kun `minAvailable` on 5, häätö sallitaan vain, jos jäljelle jää vähintään 5 *healthy*-Podia (`configure-pdb.md:131-132`). Healthy tarkoittaa, että Podin `Ready`-ehto on `True` (`configure-pdb.md:238-239`).
- **Poikkeukset:**
  - `kubectl drain --disable-eviction` poistaa Podit deletellä ja ohittaa PDB:n (`kubectl_drain/_index.md:73-76`).
  - Deploymentin tai Podin suora poisto ohittaa PDB:n (`disruptions.md:62-65`).
  - Ylläpitotyökalujen pitäisi käyttää Eviction API:a (`disruptions.md:107-109`), mutta tämä on ehto eikä takuu.
- Drain voi jumittua, jos korvaava Pod ei mahdu klusteriin. Silloin klusteriin pitää lisätä kapasiteettia (`disruptions.md:212-223`).

**Solmuvika**
- Tahattomia häiriöitä PDB ei voi estää, mutta ne lasketaan budjettiin (`disruptions.md:130-131`).
- Dokumentaatio sanoo suoraan, ettei budjetti oikeasti takaa määrää. Jos solmu kaatuu, kun ollaan jo minimissä, saatavilla olevien Podien määrä putoaa sen alle (`configure-pdb.md:148-155`).

**Yhteisvaikutus**
- Koska rolloutin ja vikojen poissaolot vievät budjetin, sallittuja häätöjä on 0 niin kauan kuin healthy-Podeja on alle 6. Drain siis odottaa rolloutin ja korvaavien Podien valmistumista. Sama mekanismi näkyy esimerkissä `disruptions.md:195-197`.

## Dokumentaation suositukset

- Levitä replikat rackeille tai vyöhykkeille anti-affinityllä tai monivyöhykeklusterilla, ja määritä resurssipyynnöt (`disruptions.md:69-79`).
- Aseta `unhealthyPodEvictionPolicy: AlwaysAllow`, jotta esimerkiksi `CrashLoopBackOff`-tilassa oleva Pod ei jumita drainia. Oletus on `IfHealthyBudget` (`disruptions.md:138-141`, `configure-pdb.md:246-274`).
- `maxUnavailable` on PDB:ssä suositeltu `minAvailable`:n sijaan, koska se mukautuu replikamäärän muutoksiin (`configure-pdb.md:174-176`).
- Varmista klusterin omistajalta, että ylläpito kunnioittaa PDB:itä (`configure-pdb.md:26-27`, `disruptions.md:58-60`).

## Mitä kannattaa muuttaa tai varmistaa

1. **Rolling update:** jos tarvitsette viisi saatavilla olevaa replikaa myös päivityksen aikana, asettakaa Deploymentin `maxUnavailable: 1` (tai 0) ja kasvattakaa `maxSurge`:a. `maxSurge` ei voi olla 0, jos `maxUnavailable` on 0 (`deployment.md:1194, 1205`).
2. **Solmuvika:** jos viisi replikaa on kova vaatimus myös vikatilanteessa, tarvitaan lisää replikoita ja hajautus solmuille tai vyöhykkeille. PDB ei tätä ratkaise. Jos yhdellä solmulla on kaksi Podia, solmun kaatuminen vie suoraan kaksi.
3. **Drain:** sopikaa, ettei `--disable-eviction`-valintaa eikä suoria poistoja käytetä. Harkitkaa `AlwaysAllow`-käytäntöä ja varmistakaa, että klusterissa on tilaa korvaaville Podeille.
4. **Readiness:** PDB laskee vain `Ready`-tilaiset Podit, joten readiness-tarkistuksen pitää kertoa todellisesta palvelukyvystä.

## Puuttuvat tiedot

- **Deploymentin `maxSurge`-arvo.** Oletus 25 % tarkoittaisi kuudella replikalla 2 lisä-Podia, koska arvo pyöristetään ylöspäin (`deployment.md:1205-1206`). Arvo vaikuttaa päivityksen kapasiteettitarpeeseen.
- **Podien jakautuminen solmuille ja vyöhykkeille**, eli montako replikaa yksi solmuvika voi viedä.
- **Klusterin vapaa kapasiteetti** korvaaville ja surge-Podeille.
- **Mitkä työkalut tekevät vapaaehtoisia häiriöitä** (autoscaler, palveluntarjoajan päivitykset) ja käyttävätkö ne Eviction API:a.
- **Mitä "käytettävissä" tarkoittaa sovelluksellenne** ja vastaako `Ready` sitä.
- Paikallisesta dokumentaatiosta puuttui `safely-drain-node`-sivu, johon linkit viittaavat. Drainin yksityiskohdat perustuvat siksi tiedostoihin `disruptions.md` ja `kubectl_drain/_index.md`.