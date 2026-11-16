**Lyhyesti:** Ei takaa. PDB, jossa `minAvailable: 5`, rajoittaa vain vapaaehtoisia häätöjä (evictions), jotka tehdään Eviction API:n kautta. Kolmesta tilanteestanne se suojaa käytännössä vain solmun drainia.

## Dokumentoidut takuut ja rajat

| Tilanne | Pitääkö viisi replikaa? | Peruste |
|---|---|---|
| **Rolling update** (`maxUnavailable: 2`) | **Ei.** Deploymentia ei rajoita PDB päivityksen aikana, joten käytettävissä voi olla vain 6 − 2 = **4** Podia. | Päivityksen takia poistetut tai käyttämättömät Podit lasketaan budjettiin, mutta "workload resources (such as Deployment and StatefulSet) are not limited by PDBs when doing rolling upgrades". Päivityksen vikojen käsittely määritellään työkuorman omassa spekissä (`concepts/workloads/pods/disruptions.md:133-136`). `maxUnavailable` kertoo, montako Podia saa päivityksen aikana olla poissa käytöstä. Prosenttiarvo pyöristetään alaspäin, ja oletus on 25 %. Esimerkin mukaan 30 %:lla käytettävissä on koko ajan vähintään 70 % halutuista Podeista (`concepts/workloads/controllers/deployment.md:1189-1199`). |
| **Solmun drain** (`kubectl drain`) | **Kyllä, ehdoin.** Häätö sallitaan vain, jos sen jälkeenkin käytettävissä on vähintään 5 valittua Podia (`reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:71-73`). Kuudella replikalla häädetään siis yksi Podi kerrallaan. | `kubectl drain` käyttää Eviction API:a. Hylätyt pyynnöt yritetään uudelleen, kunnes Podit on lopetettu tai säädettävä aikakatkaisu umpeutuu (`concepts/workloads/pods/disruptions.md:107-116`). Dokumentaatio vertaa haluttua määrää Deploymentin `.spec.replicas`-arvoon (`:118-129`). |
| **Odottamaton solmuvika** | **Ei.** | "Involuntary disruptions cannot be prevented by PDBs; however they do count against the budget" (`concepts/workloads/pods/disruptions.md:130-131`). Dokumentaatiossa on vielä erillinen huomautus: budjetti ei aidosti takaa minimimäärää, koska solmu voi kaatua juuri, kun ryhmä on jo minimikoossa (`tasks/run-application/configure-pdb.md:150-157`). |

## Ehdot ja poikkeukset, jotka vaikuttavat päätökseen

- **PDB ei rajoita kaikkia vapaaehtoisia häiriöitä.** Jos Deploymentin tai Podin poistaa suoraan, PDB ohitetaan (`concepts/workloads/pods/disruptions.md:62-65`). Klusterin ylläpitotyökalujen pitäisi kutsua Eviction API:a eikä poistaa Podeja suoraan (`:107-109`).
- **Budjetti on yhteinen kaikille häiriöille.** Päivityksessä poissa olevat Podit ja solmuvikojen kaatamat Podit kuluttavat samaa budjettia (`concepts/workloads/pods/disruptions.md:130-134`). Esimerkiksi päivityksen aikana käytettävissä voi olla vain 4 Podia, ja silloin drain ei pysty häätämään yhtään Podia ennen kuin tilanne palautuu. Sama koskee tilannetta, jossa yksi replika on kaatuneen solmun mukana: 5 käytettävissä, 0 häätöä sallittu. Tämä on päätelmä edellä viitatuista dokumentoiduista säännöistä.
- **"Käytettävissä" tarkoittaa Ready-tilaa.** PDB laskee terveiksi vain Podit, joilla on `Ready=True` (`tasks/run-application/configure-pdb.md:236-240`).
- **Epäterveet Podit ja oletuskäytäntö.** Oletuksena on `IfHealthyBudget`. Sillä käynnissä oleva mutta epäterve Podi voidaan häätää vain, jos `currentHealthy >= desiredHealthy` (`reference/kubernetes-api/policy-resources/pod-disruption-budget-v1.md:81-93`). Siksi drain voi jäädä odottamaan.
- **Liian tiukka PDB estää drainin kokonaan.** Jos `minAvailable` on 100 % tai sama kuin replikoiden määrä, eli tässä 6, drain ei valmistu koskaan (`tasks/run-application/configure-pdb.md:159-163`).

## Dokumentaation suositukset

1. **Käyttäkää `maxUnavailable`-kenttää PDB:ssä `minAvailable`:n sijaan.** Se mukautuu automaattisesti, kun replikoiden määrä muuttuu (`tasks/run-application/configure-pdb.md:174-176`). Teillä `maxUnavailable: 1` vastaa nykyistä asetusta, kun replikoita on 6.
2. **Asettakaa `unhealthyPodEvictionPolicy: AlwaysAllow`.** Silloin drainin aikana voidaan häätää myös virheellisesti toimivia Podeja (`concepts/workloads/pods/disruptions.md:138-141`). Haittapuoli: käynnistyvät Podit eivät välttämättä ehdi muuttua terveiksi (`pod-disruption-budget-v1.md:89`). Kenttä on beta-tasoa, ja feature gate `PDBUnhealthyPodEvictionPolicy` on oletuksena päällä (`:93`).

## Mitä kannattaa muuttaa tai varmistaa

- **Päivitys:** Jos viisi replikaa on ehdoton vaatimus myös päivityksen aikana, muuttakaa Deploymentin `maxUnavailable` arvoon 1. Toinen vaihtoehto on 0 yhdessä nollaa suuremman `maxSurge`-arvon kanssa, koska arvot eivät voi olla nollia yhtä aikaa (`deployment.md:1189-1194`). Vaihtoehtoisesti kasvattakaa replikamäärää. PDB:n tiukentaminen ei auta, koska se ei rajoita päivitystä.
- **Solmuvika:** PDB ei suojaa solmuvialta, joten varmistakaa replikoiden jakautuminen solmuille ja replikamäärän riittävyys. Jos yhdellä solmulla on useita replikoita, yksi solmuvika voi pudottaa käytettävissä olevien määrän alle viiden. Tätä keinoa haetuissa kohdissa ei käsitelty, joten se on tarkistamatta. Esimerkiksi topology spread -rajoitteet pitää selvittää erikseen.
- **Drain:** Varmistakaa, että kaikki ylläpito- ja automaatiotyökalut (myös pilvipalveluntarjoajan omat) käyttävät Eviction API:a. Sopikaa myös drainin aikakatkaisusta ja siitä, ettei draineja ajeta yhtä aikaa päivitysten kanssa.

## Puuttuvat tiedot

- **Replikoiden sijoittelu solmuille.** Montako replikaa voi olla samalla solmulla tai vyöhykkeellä? Tämä ratkaisee, kuinka paljon yksi solmuvika vie.
- **Deploymentin `maxSurge`- ja readiness-asetukset.** Ne vaikuttavat siihen, milloin uudet Podit lasketaan käytettäviksi.
- **Klusterin vapaaehtoisten häiriöiden lähteet.** Esimerkiksi node autoscaling ja palveluntarjoajan ylläpito, ja käyttävätkö ne Eviction API:a (`concepts/workloads/pods/disruptions.md:56-60`).
- **Drainin aikakatkaisu ja `kubectl`:n tarkka uudelleenyrityskäytös.** Näitä ei löytynyt haetuista kohdista.
- **Mihin "vähintään viisi" perustuu.** Onko se kuorman vai quorumin vaatimus? Siitä riippuu, onko neljä replikaa lyhyen päivityksen ajan hyväksyttävää.