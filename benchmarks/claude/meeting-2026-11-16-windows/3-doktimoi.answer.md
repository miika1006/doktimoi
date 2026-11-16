**Lyhyesti: ei takaa.** PDB, jossa `minAvailable: 5`, takaa vähintään viisi käytettävissä olevaa replikaa vain silloin, kun Podeja häädetään Eviction API:n kautta, esimerkiksi `kubectl drain` -komennolla. Rolling update ja odottamaton solmuvika voivat molemmat pudottaa määrän alle viiden.

## Tilanne kolmessa tapauksessa

| Tilanne | Pitääkö PDB viisi replikaa? | Peruste |
|---|---|---|
| **Solmun drain** (`kubectl drain`, Eviction API) | **Kyllä, ehdollisesti.** Kuudesta replikasta saa häätää vain yhden kerrallaan, koska häätö sallitaan vain, jos sen jälkeen vähintään `minAvailable` Podia on yhä käytettävissä. | `reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:71-73`, `concepts/workloads/pods/disruptions.md:118-121` |
| **Deploymentin rolling update** | **Ei.** Päivityksen poistamat tai käytöstä poissa olevat Podit lasketaan budjettiin, mutta PDB ei rajoita Deploymentia tai StatefulSetia päivityksen aikana. Päivitystä ohjaa workloadin oma spec. | `concepts/workloads/pods/disruptions.md:133-136` |
| **Odottamaton solmuvika** | **Ei.** PDB ei voi estää tahattomia häiriöitä, mutta ne lasketaan budjettiin. Jos solmu kaatuu, kun käytettävissä on juuri minimimäärä, määrä putoaa sen alle. | `concepts/workloads/pods/disruptions.md:130-131`, `tasks/run-application/configure-pdb.md:148-156` |

## Dokumentoidut takuut ja ehdot

- **Takuu koskee vain vapaaehtoisia häätöjä.** "A disruption budget does not truly guarantee that the specified number/percentage of pods will always be up … can only protect against voluntary evictions" (`tasks/run-application/configure-pdb.md:148-156`).
- **Kaikki vapaaehtoiset häiriöt eivät kulje PDB:n kautta.** Deploymentin tai Podin suora poisto ohittaa PDB:n (`concepts/workloads/pods/disruptions.md:62-65`). Myös `kubectl drain --disable-eviction` käyttää poistoa eikä tarkista PDB:tä (`reference/kubectl/generated/kubectl_drain/_index.md:49-119`, kohta `--disable-eviction`).
- **Drain voi jäädä odottamaan.** `kubectl drain` yrittää hylättyjä häätöjä uudelleen, kunnes solmun Podit ovat päättyneet tai aikakatkaisu täyttyy (`concepts/workloads/pods/disruptions.md:111-116`).
- **Kokonaisluku tarkoittaa Podien määrää.** Arvo `minAvailable: 5` tarkoittaa viittä Podia, ei prosenttia (`tasks/run-application/configure-pdb.md:85-91`).
- **Deploymentin `maxUnavailable: 2`** kertoo, kuinka moni Pod saa päivityksen aikana olla poissa käytöstä. Kuudella replikalla vähintään 4 Podia on siis käytettävissä, ei 5 (`concepts/workloads/controllers/deployment.md:1189-1199`).
- **Oletuksena drain voi jumittua.** `unhealthyPodEvictionPolicy`-kentän oletus on `IfHealthyBudget`: käynnissä olevan mutta ei vielä Ready-tilassa olevan Podin saa häätää vain, jos sovellus ei jo ole häiriötilassa. Esimerkiksi `CrashLoopBackOff`-tilassa olevat Podit voivat estää drainin (`tasks/run-application/configure-pdb.md:242-278`, `reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:81-93`). Ready-tilassa olevia Podeja pidetään terveinä (sama, rivi 83).

## Tästä seuraa (oma päättelyni)

- **Päivitys ja drain samaan aikaan:** jos päivitys on vienyt käytettävissä olevat Podit neljään, Eviction API ei salli yhtään häätöä, koska päivityksen Podit lasketaan budjettiin. Drain jää odottamaan, kunnes päivitys on valmis.
- **Solmuvika ennen kaikkea muuta:** jos solmulla on kaksi tai useampia replikoista, yksi vika vie määrän alle viiden suoraan.
- **Solmuvika päivityksen aikana:** käytettävissä voi olla alle neljä Podia.
- **Kuusi replikaa ja `minAvailable: 5`** tarkoittaa yhtä häätöä kerrallaan. Se toimii, mutta drain on hidas.

## Muutokset ja tarkistukset

1. **Valitse päivitykselle oikea arvo.**
   - Jos tavoite on oikeasti "aina vähintään 5", aseta Deploymentin `maxUnavailable: 1` tai `0`. Arvolla `0` `maxSurge` ei saa olla `0`, ja käytettävissä pysyy koko ajan 6 (`concepts/workloads/controllers/deployment.md:1189-1210`).
   - Jos 4 riittää päivityksen ajan, kirjatkaa se tietoisena poikkeuksena.
2. **Varautukaa solmuvikaan erikseen.** PDB ei siinä auta. Jos 5 on ehdoton alaraja, se vaatii varareplikoita, eli `replicas` on suurempi kuin 6. Tämä on oma johtopäätökseni, ei dokumentin suositus.
3. **Suositus: aseta `unhealthyPodEvictionPolicy: AlwaysAllow`,** jotta virheellisesti toimiva sovellus ei estä drainia (`concepts/workloads/pods/disruptions.md:138-141`). Hinta on se, että vielä Ready-tilaan nousemattomat Podit voidaan häätää.
4. **Varmistakaa, että drain-työkalut käyttävät Eviction API:a.** Tämä koskee myös automaatiota ja palveluntarjoajan toimia (`concepts/workloads/pods/disruptions.md:107-109`). Älkää käyttäkö `--disable-eviction`-valintaa, älkääkä poistako Podeja suoraan.
5. **Harkitkaa `maxUnavailable`-kenttää PDB:ssä `minAvailable`-kentän sijaan,** koska se mukautuu replikamäärän muutoksiin (`tasks/run-application/configure-pdb.md:170-176`). Arvo 1 vastaa nykyistä asetusta kuudella replikalla.
6. **Tarkistakaa, että PDB:n selector vastaa Deploymentin selectoria.** Tyhjä (null) selector ei valitse yhtään Podia (`reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:57-79`, `concepts/workloads/pods/disruptions.md:123-124`).

## Puuttuvat tiedot

- **Replikoiden sijoittelu solmuille:** solmujen määrä ja mahdolliset anti-affinity- tai topology spread -asetukset. Niistä riippuu, kuinka monta replikaa yksi solmuvika vie.
- **Deploymentin `maxSurge`-arvo:** sitä ei kerrottu. Oletus on 25 %, joka pyöristetään ylöspäin, eli 2 Podia (`concepts/workloads/controllers/deployment.md:1201-1205`).
- **Tarvitaanko viisi aivan aina** vai riittääkö se tavallisessa käytössä. Tämä on liiketoimintavaatimus.
- **Ajetaanko drainia kesken päivityksen.** Myös klusterin ylläpitäjän tai palveluntarjoajan automaatio voi tehdä vapaaehtoisia häiriöitä (`concepts/workloads/pods/disruptions.md:56-61`).
- **Onko `PDBUnhealthyPodEvictionPolicy`-ominaisuus päällä** teidän Kubernetes-versiossanne. Dokumentin mukaan se on oletuksena päällä ja beta-tasolla (`reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:93`).