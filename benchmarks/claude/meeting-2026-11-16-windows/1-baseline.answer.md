Lyhyt vastaus: ei takaa. PDB, jossa minAvailable on 5, rajoittaa vain Eviction API:n kautta tehtäviä vapaaehtoisia häiriöitä. Kuudella replikalla se sallii tällaisen evictionin yhdelle Podille kerrallaan. Rolling update ei noudata PDB:tä, ja `maxUnavailable: 2` sallii käytettävien replikoiden laskea neljään. Solmuvikaa PDB ei estä lainkaan.

## Tilanteittain

| Tilanne | Pysyykö käytettävissä vähintään 5 replikaa? | Peruste |
|---|---|---|
| Deploymentin rolling update | **Ei.** Deployment pitää käytettävissä vähintään 6 − 2 = **4** replikaa. | PDB ei rajoita rolling updatea |
| `kubectl drain` (Eviction API) | **Kyllä, ehdoin** | PDB estää evictionin, joka veisi terveiden Podien määrän alle viiden |
| Odottamaton solmuvika | **Ei** | PDB ei estä tahattomia häiriöitä |

## Dokumentoidut takuut ja rajat

- **PDB koskee vain vapaaehtoisia häiriöitä.** Se rajoittaa sitä, montako replikaa on vapaaehtoisten häiriöiden vuoksi alhaalla yhtä aikaa (`docs/concepts/workloads/pods/disruptions.md:99-101`). Kun minAvailable on 5, eviction sallitaan vain, jos jäljelle jää vähintään 5 tervettä valittua Podia (`docs/tasks/run-application/configure-pdb.md:131-132`). Vastaava esimerkki: viiden replikan sovelluksesta, jonka PDB sallii neljä käytettävää, Eviction API päästää yhden Podin kerrallaan (`disruptions.md:118-121`).
- **Solmuvikaa PDB ei estä.** Tahattomia häiriöitä ei voi estää PDB:llä, mutta ne lasketaan budjettiin (`disruptions.md:130-131`). Laitteistovika, VM:n katoaminen, kernel panic, verkkopartitio ja node-pressure-eviction ovat tahattomia häiriöitä (`disruptions.md:26-34`). Dokumentaatio sanoo suoraan: *"A disruption budget does not truly guarantee that the specified number/percentage of pods will always be up"*. Jos solmu kaatuu, kun sovellus on jo minimikoossa, käytettävien määrä putoaa alle rajan (`configure-pdb.md:148-155`).
  - Huomaa ristiriita: rivillä `configure-pdb.md:89-90` sanotaan "10 Pods must always be available, even during a disruption". Tämän kumoaa yllä mainittu huomautus riveillä 148–155, joten virke ei ole takuu.
- **Rolling update ei noudata PDB:tä.** Päivityksen poistamat tai käyttökelvottomiksi tekemät Podit lasketaan budjettiin, mutta Deployment ei ole rolling updatessa PDB:n rajoittama. Päivityksen aikaista käyttäytymistä säädetään Deploymentin omassa specissä (`disruptions.md:133-136`). `maxUnavailable` on suurin sallittu käyttökelvottomien Podien määrä päivityksen aikana. Esimerkiksi arvolla 30 % käytettävissä on koko ajan vähintään 70 % halutusta määrästä (`docs/concepts/workloads/controllers/deployment.md:1191-1199`). Päättymässä olevia Podeja ei lasketa käytettäviksi, ja käytettävien määrä pysyy välillä `replicas - maxUnavailable` … `replicas + maxSurge` (`deployment.md:328-329`). Teillä alaraja on siis 4.
- **Päivitys kuluttaa budjettia.** Kun päivitys on vienyt yhden tai kaksi replikaa pois käytöstä, terveitä on 5 tai vähemmän. Tällöin PDB estää samaan aikaan ajetun drainin evictionit. Tämä on johdettu riveistä `disruptions.md:133-134` ja `configure-pdb.md:131-132`.
- **Kaikki vapaaehtoiset toimet eivät kulje PDB:n kautta.** Deploymentin tai Podin poistaminen ohittaa PDB:n (`disruptions.md:62-65`). `kubectl drain` käyttää evictionia, jos API-palvelin tukee sitä, ja muuten tavallista DELETE-kutsua (`docs/reference/kubectl/generated/kubectl_drain/_index.md:27`). Lippu `--disable-eviction` ohittaa PDB-tarkistuksen kokonaan (`_index.md:72-76`). Klusterin hallintatyökalujen pitäisi käyttää Eviction API:a (`disruptions.md:107-109`).
- **"Terve" tarkoittaa Ready-tilaa.** Terve Pod on sellainen, jolla on ehto `Ready=True` (`configure-pdb.md:236-240`). Pod, joka on käynnissä mutta ei Ready-tilassa, ei siis kerrytä budjettia.

## Ehdot drainin takuulle

PDB pitää viisi replikaa käytettävissä drainin aikana vain, jos kaikki seuraavat pätevät:

1. Drain käyttää Eviction API:a eikä `--disable-eviction`-lippua tai suoria poistoja.
2. PDB:n selektori vastaa Deploymentin selektoria (`disruptions.md:123-128`).
3. Solmuvikaa tai päivitystä ei tapahdu samaan aikaan.

Drain voi myös jäädä odottamaan. Kun ensimmäinen eviction on tehty, uusia ei sallita ennen kuin korvaava Pod on Ready. Jos korvaavalle Podille ei löydy kapasiteettia, drain jumittuu (`disruptions.md:195-223`). Oletuskäytäntö `IfHealthyBudget` voi lisäksi estää drainin, jos jokin Pod on CrashLoopBackOff-tilassa tai ei raportoi Ready-tilaa (`configure-pdb.md:249-264`).

## Suositukset

1. **Laske päivityksen `maxUnavailable` arvoon 1**, jos haluatte vähintään viisi käytettävää replikaa myös päivityksen aikana. Vaihtoehto on `maxUnavailable: 0` ja `maxSurge` vähintään 1, jolloin alaraja on 6. Arvo ei voi olla 0, jos myös `maxSurge` on 0 (`deployment.md:1194`, `1205`).
2. **Harkitse PDB:hen `maxUnavailable: 1` minAvailable-arvon sijaan.** Kuudella replikalla merkitys on sama, mutta dokumentaatio suosittelee `maxUnavailable`-kenttää, koska se seuraa replikamäärän muutoksia automaattisesti (`configure-pdb.md:174-176`).
3. **Aseta `unhealthyPodEvictionPolicy: AlwaysAllow`**, jotta virheellisesti toimivat Podit eivät estä drainia (`disruptions.md:138-141`, `configure-pdb.md:266-274`). Ehto: ominaisuuslippu `PDBUnhealthyPodEvictionPolicy` (`configure-pdb.md:244`) ja klusterin versio pitää tarkistaa.
4. **Varaudu solmuvikaan eri keinoin.** Hajauta replikat solmuille, telineisiin tai vyöhykkeille anti-affinityllä ja määritä resurssipyynnöt (`disruptions.md:69-79`). Jos viiden replikan on kestettävä yhden solmun menetys, kuusi replikaa riittää vain, jos samalla solmulla on enintään yksi replika. Muuten tarvitaan lisää replikoita. Tämä on päätelmä, ei dokumentoitu takuu.
5. **Sopikaa klusterin ylläpidon kanssa**, että drain ja automaatio, kuten solmupäivitykset ja autoscaler, käyttävät Eviction API:a (`disruptions.md:58-59`, `81-89`). Varmistakaa myös, että drain-kapasiteettia riittää korvaaville Podeille.

## Puuttuvat tiedot

- **`maxSurge`-arvo:** sitä ei kerrottu. Oletus on 25 % (`deployment.md:1206`).
- **Podien sijoittelu solmuille:** tämä ratkaisee, montako replikaa yksi solmuvika vie.
- **Readiness-probejen määritys:** se määrää, milloin Pod lasketaan terveeksi.
- **Drain-työkalut ja niiden liput** sekä se, onko klusterissa automaattisia vapaaehtoisia häiriöitä.
- **Klusterin vapaa kapasiteetti** korvaaville Podeille.
- **Kubernetes-versio ja ominaisuuslippujen tila** `unhealthyPodEvictionPolicy`-kenttää varten.
- **Sovelluksen todellinen vaatimus:** jos 5 on ehdoton minimi, kuusi replikaa on liian vähän, koska yksi solmuvika tai yksi PDB:n sallima eviction vie sovelluksen jo rajalle.