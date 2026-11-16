**Lyhyesti: ei takaa.** PDB, jonka `minAvailable` on 5, rajoittaa vain vapaaehtoisia häiriöitä, jotka tehdään Eviction API:n kautta. Käytännössä se suojaa teidän kolmesta tilanteesta vain drainia. Rolling updatessa saatavilla voi olla 4 replikaa ja solmuvian jälkeen vielä vähemmän.

## Tilanteet yksitellen

### 1. Deploymentin rolling update (`maxUnavailable: 2`): ei takuuta
- **Dokumentoitu:** Rolling updaten takia poistetut tai ei-saatavilla olevat podit lasketaan budjettiin. Deployment ja StatefulSet eivät kuitenkaan ole PDB:n rajoittamia rolling updatessa. Päivityksen aikaiset viat määritetään workload-resurssin omassa specissä. `concepts/workloads/pods/disruptions.md:133-136`
- **Dokumentoitu:** `maxUnavailable` on päivityksen aikana ei-saatavilla olevien podien enimmäismäärä. Prosenttiarvosta laskettu luku pyöristetään alaspäin, ja oletus on 25 %. Esimerkiksi arvolla 30 % saatavilla on koko ajan vähintään 70 %. `concepts/workloads/controllers/deployment.md:1189-1199`
- **Johtopäätös:** Kun replikoita on 6 ja `maxUnavailable: 2`, Deployment saa pudottaa saatavilla olevien määrän 4:ään, eikä PDB estä sitä.

### 2. Solmun drain: rajattu takuu, joka toimii vain ehtojen täyttyessä
- **Dokumentoitu:** PDB rajoittaa samanaikaisesti alhaalla olevien podien määrää vapaaehtoisissa häiriöissä. `disruptions.md:99-101`
- **Dokumentoitu esimerkki:** Kun Deploymentissa on 5 replikaa ja PDB sallii 4, Eviction API sallii yhden podin häirinnän kerrallaan mutta ei kahden. `disruptions.md:118-121` Teidän tapauksessanne (6 replikaa, vähintään 5) sama logiikka tarkoittaa, että yksi evictio kerrallaan sallitaan, jos kaikki 6 ovat terveitä.
- **Ehto: työkalun pitää käyttää Eviction API:a.** Ylläpitäjien kuuluu käyttää PDB:tä kunnioittavia työkaluja, jotka kutsuvat Eviction API:a eivätkä poista podeja suoraan. `disruptions.md:107-109` `kubectl drain` käyttää tavallista DELETE-kutsua, jos API-palvelin ei tue evictiota. `reference/kubectl/generated/kubectl_drain/_index.md:27`
- **Ehto: drain voi jäädä odottamaan.** Hylätyt evictiot yritetään uudelleen, kunnes podit ovat päättyneet tai määritettävä aikakatkaisu täyttyy. `disruptions.md:111-116` Jos kaikki 6 eivät ole terveitä, esimerkiksi kesken rolling updaten, budjetti voi olla jo käytetty ja drain jumittuu.
- **Oletuskäytös:** `IfHealthyBudget`. Käynnissä olevan mutta epäterveen podin saa evictoida vain, jos `currentHealthy ≥ desiredHealthy`. Tämän takia esimerkiksi `CrashLoopBackOff`-tilassa olevat podit voivat estää drainin. `tasks/run-application/configure-pdb.md:242-264`
- **Poikkeus:** `Pending`-, `Succeeded`- ja `Failed`-vaiheessa olevat podit voidaan aina evictoida. `configure-pdb.md:276-278`

### 3. Odottamaton solmuvika: ei takuuta
- **Dokumentoitu:** PDB ei voi estää tahattomia häiriöitä, mutta ne lasketaan budjettiin. `disruptions.md:130-131`
- **Dokumentoitu:** Budjetti ei oikeasti takaa, että määritetty määrä on aina ylhäällä. Jos solmu kaatuu, kun joukko on jo minimikoossa, saatavilla olevien määrä putoaa sen alle. `configure-pdb.md:149-156`
- **Johtopäätös:** Solmuvian jälkeen saatavilla on 6 miinus kyseisellä solmulla olleiden podien määrä. Jos vika osuu drainin aikana, kun saatavilla on jo vain 5, tulos on 4 tai vähemmän.

## Suositukset dokumentaatiosta
- Aseta PDB:lle `unhealthyPodEvictionPolicy: AlwaysAllow`, jotta huonosti käyttäytyvät sovellukset eivät estä drainia. `disruptions.md:138-141` Varjopuoli: päivityksessä olevat podit eivät välttämättä ehdi muuttua terveiksi. `configure-pdb.md:266-274`
- Käytä PDB:ssä mieluummin `maxUnavailable`-kenttää kuin `minAvailable`-kenttää, koska se mukautuu automaattisesti replikamäärän muutoksiin. `configure-pdb.md:174-176` Teille vastaava arvo olisi `maxUnavailable: 1`.
- Älä aseta `minAvailable`-arvoksi replikamäärää (6). Silloin vapaaehtoisia evictioita sallitaan nolla, eikä drain valmistu koskaan. `configure-pdb.md:158-162`

## Mitä teidän kannattaa muuttaa tai varmistaa
Nämä ovat omia päätelmiäni edellä olevan dokumentaation pohjalta:
1. **Rolling update:** Jos 5 saatavilla olevaa replikaa on vaatimus myös päivityksen aikana, muuta `maxUnavailable: 2` arvoon `1`. Toinen vaihtoehto on `0` yhdessä arvon `maxSurge ≥ 1` kanssa. Molemmat eivät voi olla 0. `deployment.md:1194, 1203-1206`
2. **Solmuvika:** PDB ei ratkaise tätä. Kestävyys solmuvikaa vastaan vaatii lisää replikoita ja sen, että podit hajautetaan eri solmuille. Esimerkiksi 7 replikaa, joista enintään yksi on kullakin solmulla, jättää yhden solmuvian jälkeen 6. Tämä on oma päätelmäni; hajautuksen toteutustapaa en tarkistanut dokumentaatiosta.
3. **Drain:** Varmistakaa, että kaikki ylläpito- ja autoscaler-työkalut käyttävät Eviction API:a. Asettakaa drainille aikakatkaisu, ja harkitkaa `AlwaysAllow`-käytäntöä.
4. **Ajoitus:** Välttäkää drainia kesken rolling updaten, koska päivityksen ei-saatavilla olevat podit kuluttavat samaa budjettia.

## Puuttuvat tiedot
- Miten 6 podia jakautuvat solmuille. Se ratkaisee, paljonko yksi solmuvika vie.
- Deploymentin `maxSurge`-arvo ja readiness-asetukset, joista päivityksen todellinen saatavuus riippuu.
- Mitkä työkalut tekevät drainin ja kutsuvatko ne Eviction API:a.
- Klusterin versio ja `PDBUnhealthyPodEvictionPolicy`-ominaisuuden tila (`configure-pdb.md:244`).
- Tarkoitetaanko "käytettävissä olevalla" PDB:n tervettä podia (`currentHealthy`) vai palvelun todellista kapasiteettia.