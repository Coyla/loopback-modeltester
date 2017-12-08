'use strict';

// Require Node.JS package
const assert = require('assert');
const { createReadStream } = require('fs');
const { basename } = require('path');

// Require NPM Packages
const request = require('request-promise');
const { eachSeries } = require('async');
const { has, get } = require('lodash');
const is = require('@sindresorhus/is');
const mime = require('mime-types');
const chalk = require('chalk');

const warn = chalk.yellow.bold;

function loopbackModelTester(app, config, {basePath = 'api'}) {
  if ('undefined' === typeof(app)) {
    throw new TypeError('App cannot be undefined!');
  }
  if ('undefined' === typeof(config)) {
    throw new TypeError('Config cannot be undefined');
  }
  if (config instanceof Array === false) {
    throw new TypeError('Config should be an array!');
  }

  app.on('started', async function() {
    const baseUrl = app.get('url').replace(/\/$/, '');
    let testIndex = 0;
    let context = {};
    eachSeries(config, function(route, done) {
      console.time(route.title);
      console.log('------------------------------------------------');
      console.log(`\nRun test [${chalk.yellow.bold(testIndex)}] - ${warn(route.title) || ''}`);
      testIndex++;
      if (route.skip === true) {
        console.log(chalk.blue.bold('Test skipped...'));
        return done();
      }

      route.url = route.url.replace(/\${([a-zA-Z0-9._-]+)}/g, function(match, matchValue) {
        if (context.hasOwnProperty(matchValue) === false) {
          return;
        }
        return context[matchValue];
      });

      // Hydrate context for headers keys!
      if('object' === typeof(route.headers)) {
        Object.keys(route.headers).forEach((key) => {
          if(is(route.headers[key]) !== 'string') return;
          route.headers[key].replace(/\${([a-zA-Z0-9._-]+)}/g, function(match, matchValue) {
            if (context.hasOwnProperty(matchValue) === false) {
              return;
            }
            route.headers[key] = route.headers[key].replace(new RegExp('\\' + match, 'g'), context[matchValue]);
          });
        });
      }

      const reqOption = {
        method: route.method || 'GET',
        url: `${baseUrl}/${basePath}${typeof(route.model) === 'string' ? '/' + route.model : ''}/${route.url}`,
        formData: route.formData || void 0,
        body: route.body || void 0,
        headers: route.headers || void 0,
        qs: route.qs || void 0,
        resolveWithFullResponse: true,
        json: true
      };

      if (route.debug === true) {
        console.log(chalk.magenta.bold('[DEBUG ON]'));
        console.log('--> Request options :');
        console.log(chalk.gray.bold(JSON.stringify(reqOption, null, 2)));
      }

      const { expect = {}, file, variables } = route;
      if ('undefined' === typeof(expect.statusCode)) {
        expect['statusCode'] = 200;
      }

      // Upload a file!
      uploadFile: if ('object' === typeof(file)) {
        if ('undefined' === typeof(file.path)) break uploadFile;
        let formName = file.form_name;
        if ('undefined' === typeof(formName)) {
          formName = 'file';
        }
        try {
          const name = basename(file.path);
          reqOption.formData = {
            name
          };
          reqOption.formData[formName] = {
            value: createReadStream(file.path),
            options: {
              filename: name,
              contentType: mime.lookup(name)
            }
          };
        } catch (E) {
          return done(E);
        }
      }
      
      request(reqOption).then((resp) => {
        const { body, statusCode, headers } = resp;

        if (route.debug === true) {
          console.log('--> Body :');
          console.log(chalk.gray.bold(JSON.stringify(body, null, 2)));
          console.log('\n--> Headers :');
          console.log(chalk.gray.bold(JSON.stringify(headers, null, 2)));
        }

        // Check response statusCode
        assert.equal(statusCode, expect.statusCode, `Invalid response statusCode. Should be ${chalk.green.bold(expect)} but returned code ${chalk.red.bold(statusCode)}`);
        console.log(`    statusCode = ${chalk.green.bold(expect.statusCode)}`);

        // Check return Type
        if ('string' === typeof(expect.bodyType)) {
          const isType = is(body).toLowerCase();
          expect.bodyType = expect.bodyType.toLowerCase();
          assert.equal(isType, expect.bodyType, `Invalid type for the returned response body. Should be ${chalk.green.bold(expect.bodyType)} but detected as ${chalk.red.bold(isType)}`);
          console.log(`    bodyType = ${chalk.green.bold(expect.bodyType)}`);

          // Check properties keys if the returned type is an Object!
          if (isType === 'object' && 'object' === typeof(expect.properties)) {
            console.log(chalk.bold.cyan('    -> Body properties ='));
            Object.keys(expect.properties).forEach((key) => {
              const propertyType = expect.properties[key].toLowerCase();
              if (!has(body, key)) {
                throw new Error(`Missing body response key ${key}`);
              }
              if (propertyType === 'any') return;
              const bodyType = is(get(body, key)).toLowerCase();
              if (bodyType !== propertyType) {
                throw new TypeError(`Property ${chalk.blue.bold(key)} should be ${chalk.green.bold(propertyType)} but the returned property was ${chalk.yellow.bold(bodyType)}`);
              }
              console.log(`        Key: ${warn(key)} = ${chalk.bold.green(propertyType)}`);
            });
          }
        }
        
        // Check header value!
        if ('object' === typeof(expect.headers)) {
          console.log(chalk.cyan.bold('    -> Header properties :'))
          Object.keys(expect.headers).forEach((headerKey) => {
            headerKey = headerKey.toLowerCase();
            if (headers.hasOwnProperty(headerKey) === false) {
              throw new Error(`Key ${chalk.green.bold(headerKey)} is not present in the response headers!`);
            }
            assert.equal(
              headers[headerKey].includes(expect.headers[headerKey]), 
              true, 
              `Invalid headers value for the key ${chalk.bold.blue(headerKey)}. Should be (or contains) ${chalk.bold.green(expect.headers[headerKey])} but was ${chalk.bold.red(headers[headerKey])}}`
            );
            console.log(`        Key: ${warn(headerKey)} = ${chalk.bold.green(expect.headers[headerKey])}`);
          });
        }

        if ('object' === typeof(variables)) {
          Object.keys(variables).forEach((varName) => {
            const varOptions = variables[varName];
            if (has(body, varName)) {
              const registerVar = 'boolean' === typeof(varOptions.register) ? varOptions.register : true;
              const varValue = get(body, varName);
              if(registerVar) {
                const finalVarName = varOptions.name || varName;
                context[finalVarName] = varValue;
                console.log(`Assign new variable ${chalk.bold.blue(finalVarName)} with value ${chalk.bold.yellow(varValue)} into the context!`);
              }
              if ('undefined' !== typeof(varOptions.value)) {
                if(varValue !== varOptions.value) {
                  throw new Error(`Variable ${chalk.bold.green(varName)} value should be ${chalk.blue.bold(varOptions.value)} but was detected as ${chalk.red.bold(varValue)}`);
                }
              }
            } else {
              if (varOptions.required === true) {
                throw new Error(`Variable ${chalk.bold.green(varName)} is missing from the response body. Cannot be applied to the test Context!`);
              }
            }
          });
        }

        console.timeEnd(route.title);
        done(null);
        return null;
      }).catch(done);
    }, (err) => {
      if (err) {
        console.error(`\nstatusCode: ${warn(err.statusCode || 'unknow code')}`);
        console.error(`message: ${err.message}`);
        process.exit(1);
      }
      console.log('\n\n' + chalk.green.bold('All tests successfully passed!'));
      process.exit(0);
    });
  });
  app.start();
}

// Export loopbackModelTester handler
module.exports = loopbackModelTester;
