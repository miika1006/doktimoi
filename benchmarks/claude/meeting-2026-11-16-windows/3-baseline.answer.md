**Lyhyesti: ei takaa.** PDB, jossa `minAvailable: 5`, rajoittaa vain Eviction API:n kautta tehtäviä vapaaehtoisia häiriöitä, eli käytännössä drain-operaatiota. Rolling update ei noudata PDB:tä, ja `maxUnavailable: 2` sallii päivityksen aikana pudotuksen neljään replikaan. Solmuvikaa PDB ei estä lainkaan.

## Tilanne kolmessa tapauksessa

| Tilanne | Pysyykö vähintään 5? | Peruste |
|---|---|---|
| Rolling update, `maxUnavailable: 2` | **Ei.** Takuu on 6 − 2 = 4 käytettävissä olevaa | Deploymentit eivät ole PDB:n rajoittamia rolling updatessa (`docs/concepts/workloads/pods/disruptions.md:133-136`). `maxUnavailable` on päivityksen aikana poissa olevien Podien enimmäismäärä (`docs/concepts/workloads/controllers/deployment.md:1191-1199`). |
| Solmun drain | **Kyllä, ehdoin** | Eviction sallitaan vain, jos sen jälkeen jää vähintään 5 tervettä Podia (`docs/tasks/run-application/configure-pdb.md:131-132`). Kuudella replikalla tämä tarkoittaa yhtä evictionia kerrallaan. |
| Odottamaton solmuvika | **Ei** | PDB ei estä tahattomia häiriöitä, mutta ne lasketaan budjettiin (`disruptions.md:130-131`). Jos solmu kaatuu, kun replikoita on jo minimimäärä, niitä jää alle 5 (`configure-pdb.md:148-155`). |

## Dokumentoidut takuut

- Eviction API ei poista tervettä Podia, jos sen jälkeen jäisi alle `minAvailable`-määrän (`configure-pdb.md:131-132`, `246-247`).
- `kubectl drain` käyttää Eviction API:a. Hylätyt evictionit se yrittää uudelleen, kunnes Podit ovat poissa tai aikakatkaisu umpeutuu (`disruptions.md:111-116`).
- Rolling update takaa vähintään `replicas − maxUnavailable` käytettävissä olevaa Podia (`deployment.md:1196-1199`). Teillä se on 4. Absoluuttinen arvo 2 on täsmälleen 2. Prosenttiarvo pyöristettäisiin alaspäin (`deployment.md:1193-1194`).

## Ehdot ja poikkeukset

- **Terve tarkoittaa Ready-tilaa.** PDB laskee terveiksi vain Podit, joiden ehto on `Ready=True` (`configure-pdb.md:238-239`). Takuu on siis vain niin hyvä kuin readiness probe.
- **Rolling update ja drain samaan aikaan:** päivityksen takia poistetut tai käyttökelvottomat Podit lasketaan budjettiin (`disruptions.md:133-134`). Päivityksen aikana sallittuja häiriöitä on silloin 0, ja drain jää odottamaan. Tämä on toivottua, mutta voi pidentää huoltoikkunaa.
- **Drain voi ohittaa PDB:n:**
  - `kubectl drain --disable-eviction` käyttää poistoa evictionin sijaan ja ohittaa PDB-tarkistuksen (`docs/reference/kubectl/generated/kubectl_drain/_index.md:73-76`).
  - Deploymentin tai Podin suora poisto ohittaa PDB:n (`disruptions.md:62-65`).
- **Muut ohitukset:**
  - Kubelet ei noudata PDB:tä node-pressure evictionissa (`docs/concepts/scheduling-eviction/node-pressure-eviction.md:32-33`).
  - Prioriteettipohjainen preemption noudattaa PDB:tä vain "best effort" -periaatteella (`docs/concepts/scheduling-eviction/pod-priority-preemption.md:230-238`).
- **Kapasiteetti ratkaisee:** drain voi jäädä jumiin, jos korvaavalle Podille ei löydy tilaa klusterista (`disruptions.md:212-223`).
- **Klusterin ylläpitäjän työkalut:** niiden pitää kutsua Eviction API:a, ja se pitää varmistaa ylläpitäjältä tai palveluntarjoajalta (`disruptions.md:107-109`, `configure-pdb.md:26-27`).
- **Päällekkäiset PDB:t:** jos Podiin osuu useampi PDB, sen eviction estetään kokonaan (`configure-pdb.md:297-299`). PDB:n selektorin pitää olla sama kuin Deploymentin (`configure-pdb.md:50-51`).

## Dokumentaation suositukset

- Hajauttakaa replikat solmuille ja vyöhykkeille anti-affinityllä (`disruptions.md:75-79`).
- Asettakaa PDB:hen `unhealthyPodEvictionPolicy: AlwaysAllow`. Muuten esimerkiksi CrashLoopBackOff-tilassa olevat Podit voivat estää drainin (`disruptions.md:138-141`, `configure-pdb.md:259-264`).
- `maxUnavailable` on suositeltavampi kuin `minAvailable`, koska se mukautuu replikamäärän muutoksiin (`configure-pdb.md:174-176`). Kiinteä `minAvailable: 5` muuttuu ongelmaksi skaalattaessa. Esimerkiksi viidellä replikalla se estää kaikki evictionit, ja drain ei valmistu koskaan (`configure-pdb.md:157-161`).

## Mitä muuttaa tai varmistaa

1. **Rolling update:** jos vähintään 5 replikaa on oikea vaatimus, asettakaa `maxUnavailable: 1`. Tiukempi vaihtoehto on `maxUnavailable: 0` ja `maxSurge` vähintään 1. Molemmat eivät voi olla nollia (`deployment.md:1194`, `1205`). Ylimääräinen Pod vaatii klusterista lisäkapasiteettia.
2. **Solmuvika:** varmistakaa, että samalla solmulla on enintään yksi replika. Silloin yksittäinen solmuvika vie normaalitilassa vain yhden replikan. Jos vika osuu drainin tai päivityksen aikaan, kun replikoita on jo 5, jäljelle jää 4. Jos vähintään 5 on ehdoton vaatimus myös silloin, lisätkää replikoita, esimerkiksi 7. Tämä on oma johtopäätökseni, ei dokumentin suositus.
3. **Drain-käytäntö:** sopikaa, ettei `--disable-eviction`-lippua käytetä, ja varmistakaa, että ylläpidon ja autoskaalauksen työkalut käyttävät Eviction API:a.
4. **Readiness probe:** tarkistakaa, että se kuvaa todellista palvelukykyä. PDB laskee vain Ready-tilaiset Podit.
5. **PDB:n asetukset:** lisätkää `AlwaysAllow` ja harkitkaa `maxUnavailable: 1` -muotoa `minAvailable: 5`:n sijaan.

## Puuttuvat tiedot

- Solmujen määrä ja replikoiden sijoittelu (anti-affinity tai topology spread)
- Deploymentin nykyinen `maxSurge`. Oletus on 25 %, eli kuudella replikalla 2 (`deployment.md:1206`).
- Klusterin vapaa kapasiteetti korvaaville ja ylimääräisille Podeille
- Mitä drain- ja autoskaalaustyökaluja ylläpitäjä tai palveluntarjoaja käyttää ja noudattavatko ne PDB:tä
- Onko käytössä PriorityClass-preemption ja millaiset node-pressure-eviction-kynnykset ovat
- Readiness proben määrittely