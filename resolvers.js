/**
 * Created by intsco on 1/11/17.
 */

const sprintf = require('sprintf-js'),
  fetch = require('node-fetch'),
  jsondiffpatch = require('jsondiffpatch'),
  jwt = require('jwt-simple'),
  slack = require('node-slack');

const config = require('./config'),
  {esSearchResults, esCountResults, esAnnotationByID} = require('./esConnector'),
  {datasetFilters, dsField, SubstringMatchFilter} = require('./datasetFilters.js'),
  generateProcessingConfig = require("./utils.js").generateProcessingConfig;

const dbConfig = () => {
  const {host, database, user, password} = config.db;
  return {
    host, database, user, password,
    max: 10, // client pool size
    idleTimeoutMillis: 30000
  };
};

let pg = require('knex')({
  client: 'pg',
  connection: dbConfig(),
  searchPath: 'knex,public'
});

function checkPermissions(datasetId, payload) {
  return pg.select().from('dataset').where('id', '=', datasetId)
    .then(records => {
      if (records.length == 0)
        throw new Error("no dataset with specified id");
      metadata = records[0].metadata;

      let allowUpdate = false;
      if (payload.role == 'admin')
        allowUpdate = true;
      else if (payload.email == metadata.Submitted_By.Submitter.Email)
        allowUpdate = true;
      if (!allowUpdate)
        throw new Error("you don't have permissions to edit this dataset");
    });
}

const slackConn = config.SLACK_WEBHOOK_URL ? new slack(config.slack.webhook_url): null;

const Resolvers = {
  Person: {
    name(obj) { return obj.First_Name; },
    surname(obj) { return obj.Surname; },
    email(obj) { return obj.Email; }
  },

  Query: {
    datasetByName(_, { name }) {
      return pg.select().from('dataset').where('name', '=', name)
        .then((data) => {
          return data.length > 0 ? data[0] : null;
        })
        .catch((err) => {
          console.log(err); return null;
        });
    },

    dataset(_, { id }) {
      return pg.select().from('dataset').where('id', '=', id)
        .then((data) => {
          return data.length > 0 ? data[0] : null;
        })
        .catch((err) => {
          console.log(err); return null;
        });
    },

    allDatasets(_, {orderBy, sortingOrder, offset, limit, filter}) {
      let q = pg.select().from('dataset');

      console.log(JSON.stringify(filter));

      for (var key in datasetFilters) {
        const val = filter[key];
        if (val)
          q = datasetFilters[key].pgFilter(q, val);
      }

      const orderVar = orderBy == 'ORDER_BY_NAME' ? 'name' : 'id';
      const ord = sortingOrder == 'ASCENDING' ? 'asc' : 'desc';

      console.log(q.toString());

      return q.orderBy(orderVar, ord).offset(offset).limit(limit)
        .catch((err) => { console.log(err); return []; });
    },

    allAnnotations(_, args) {
      return esSearchResults(args);
    },

    countAnnotations(_, args) {
      return esCountResults(args);
    },

    annotation(_, { id }) {
      return esAnnotationByID(id);
    },

    metadataSuggestions(_, { field, query }) {
      let f = new SubstringMatchFilter(field, {}),
          q = pg.distinct(pg.raw(f.pgField + " as field")).select().from('dataset');
      return f.pgFilter(q, query).orderBy('field', 'asc')
              .then(results => results.map(row => row['field']));
    }
  },

  Analyzer: {
    resolvingPower(msInfo, { mz }) {
      const rpMz = msInfo.rp.mz,
        rpRp = msInfo.rp.Resolving_Power;
      if (msInfo.type.toUpperCase() == 'ORBITRAP')
        return Math.sqrt(rpMz / mz) * rpRp;
      else if (msInfo.type.toUpperCase() == 'FTICR')
        return (rpMz / mz) * rpRp;
      else
        return rpRp;
    }
  },

  Dataset: {
    metadataJson(ds) {
      return JSON.stringify(ds.metadata);
    },

    institution(ds) { return dsField(ds, 'institution'); },
    organism(ds) { return dsField(ds, 'organism'); },
    organismPart(ds) { return dsField(ds, 'organismPart'); },
    condition(ds) { return dsField(ds, 'condition'); },
    polarity(ds) { return dsField(ds, 'polarity').toUpperCase(); },
    ionisationSource(ds) { return dsField(ds, 'ionisationSource'); },
    maldiMatrix(ds) { return dsField(ds, 'maldiMatrix'); },

    submitter(ds) {
      return ds.metadata.Submitted_By.Submitter;
    },

    principalInvestigator(ds) {
      return ds.metadata.Submitted_By.Principal_Investigator;
    },

    analyzer(ds) {
      const msInfo = ds.metadata.MS_Analysis;
      return {
        'type': msInfo.Analyzer,
        'rp': msInfo.Detector_Resolving_Power
      };
    },

    /* annotations(ds, args) {
     args.datasetId = ds.id;
     return esSearchResults(args);
     } */
  },

  Annotation: {
    id(hit) {
      return hit._id;
    },

    sumFormula(hit) {
      return hit._source.sf;
    },

    possibleCompounds(hit) {
      const ids = hit._source.comp_ids;
      const names = hit._source.comp_names;
      let compounds = [];
      for (var i = 0; i < names.length; i++) {
        let id = ids[i];
        let infoURL;
        if (hit._source.db_name == 'HMDB') {
          id = sprintf.sprintf("HMDB%05d", id);
          infoURL = `http://www.hmdb.ca/metabolites/${id}`;
        } else if (hit._source.db_name == 'ChEBI') {
          id = "CHEBI:" + id;
          infoURL = `http://www.ebi.ac.uk/chebi/searchId.do?chebiId=${id}`;
        } else if (hit._source.db_name == 'SwissLipids') {
          id = sprintf.sprintf("SLM:%09d", id);
          infoURL = `http://swisslipids.org/#/entity/${id}`;
        } else if (hit._source.db_name == 'LIPID_MAPS') {
          infoURL = `http://www.lipidmaps.org/data/LMSDRecord.php?LMID=${id}`;
        }

        compounds.push({
          name: names[i],
          imageURL: `http://${config.services.mol_image_server_host}/mol-images/${hit._source.db_name}/${id}.svg`,
          information: [{database: hit._source.db_name, url: infoURL}]
        });
      }
      return compounds;
    },

    adduct: (hit) => hit._source.adduct,

    mz: (hit) => parseFloat(hit._source.centroid_mzs[0]),

    fdrLevel: (hit) => hit._source.fdr,

    msmScore: (hit) => hit._source.msm,

    rhoSpatial: (hit) => hit._source.image_corr,

    rhoSpectral: (hit) => hit._source.pattern_match,

    rhoChaos: (hit) => hit._source.chaos,

    dataset(hit) {
      return {
        id: hit._source.ds_id,
        name: hit._source.ds_name,
        metadata: hit._source.ds_meta
      }
    },

    ionImage(hit) {
      return {
        url: hit._source.ion_image_url,
        totalIntensity: hit._source.total_iso_ints.reduce((x,y) => x+y, 0)
      };
    },

    peakChartData(hit) {
      const {sf_adduct, ds_meta, ds_id, mz} = hit._source;
      const msInfo = ds_meta.MS_Analysis;
      const host = config.services.moldb_service_host,
        pol = msInfo.Polarity.toLowerCase() == 'positive' ? '+1' : '-1',
    /*
      // sm-engine doesn't use instrument model yet, so disable it here

        instr = msInfo.Analyzer.toLowerCase(),
        rp = msInfo.Detector_Resolving_Power.Resolving_Power,
        at_mz = msInfo.Detector_Resolving_Power.mz,
        url = `http://${host}/v1/isotopic_pattern/${sf_adduct}/${instr}/${rp}/${at_mz}/${pol}`;

      return fetch(url).then(res => res.json()).then(json => JSON.stringify(json.data));
    */
        ds_config = pg.select('config').from('dataset').where('id', '=', ds_id).first();
      // FIXME: export dataset config to ES

      return ds_config.then(row => {
        const {config} = row;
        let rp = mz / (config.isotope_generation.isocalc_sigma * 2.35482),
            ppm = config.image_generation.ppm,
            theorData = fetch(`http://${host}/v1/isotopic_pattern/${sf_adduct}/tof/${rp}/400/${pol}`);

        return theorData.then(res => res.json()).then(json => {
          let {data} = json;
          data.ppm = ppm;
          return JSON.stringify(data);
        });
      });
    },

    isotopeImages(hit) {
      const {iso_image_urls, centroid_mzs, total_iso_ints} = hit._source;
      return iso_image_urls.map((url, i) => ({
        url,
        mz: parseFloat(centroid_mzs[i]),
        totalIntensity: total_iso_ints[i]
      }));
    }
  },

  Mutation: {
    submitDataset(_, args) {
      const {name, path, metadataJson} = args;
      try {
        const payload = jwt.decode(args.jwt, config.jwt.secret);
        
        const metadata = JSON.parse(metadataJson);
        const body = JSON.stringify({
          id: args.id,
          name: name,
          input_path: path,
          metadata: metadata,
          config: generateProcessingConfig(metadata)
        });
        
        const url = `http://${config.services.sm_engine_api_host}/datasets/add`;
        return fetch(url, { method: 'POST', body: body })
          .then(() => "success");
      } catch (e) {
        console.log(e);
        return e.message;
      }
    },
    
    updateMetadata(_, args) {
      const {datasetId, metadataJson} = args;
      try {
        const payload = jwt.decode(args.jwt, config.jwt.secret);
        const newMetadata = JSON.parse(metadataJson);
        
        return checkPermissions(datasetId, payload)
          .then( () => {
            const body = JSON.stringify({
              metadata: newMetadata,
              config: generateProcessingConfig(newMetadata)
            });
            const url = `http://${config.services.sm_engine_api_host}/datasets/${datasetId}/update`;
            return fetch(url, { method: 'POST', body: body });
          })
          .then(() => {
            return pg.select().from('dataset').where('id', '=', datasetId)
              .then(records => {
                const oldMetadata = records[0].metadata;
                const delta = jsondiffpatch.diff(oldMetadata, newMetadata),
                  diff = jsondiffpatch.formatters.jsonpatch.format(delta);

                // send a Slack notification about the change
                if (slackConn) {
                  let msg = slackConn.send({
                    text: `${payload.name} edited metadata of ${oldDatasetName} (id: ${datasetId})` +
                    "\nDifferences:\n" + JSON.stringify(diff, null, 2),
                    channel: config.SLACK_CHANNEL
                  });
                }
              });
          })
          .then(() => "success");
      } catch (e) {
        console.log(e);
        return e.message;
      }
    },
    
    deleteDataset(_, args) {
      const {datasetId} = args;
  
      try {
        const payload = jwt.decode(args.jwt, config.jwt.secret);
        return checkPermissions(datasetId, payload)
          .then( () => {
            const url = `http://${config.services.sm_engine_api_host}/datasets/${datasetId}/delete`;
            return fetch(url, {method: 'POST'});
          }).then(res => res.statusText);
      } catch (e) {
        console.log(e);
        return e.message;
      }
    }
  }
};

module.exports = Resolvers;
