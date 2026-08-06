import os
import json
import pickle
import torch
import torch.nn as nn
import numpy as np
from tqdm import tqdm
from dataset import NIA2022_GEBD
from torch.utils.data import DataLoader
from config import *
from validation import validate
import argparse

class NpEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)

if __name__ == "__main__":
    
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='')
    parser.add_argument('--results_pred_json', default='')
    parser.add_argument('--results_f1_json', default='')
    args = parser.parse_args()


    mode='test'
    test_dataloader = DataLoader(NIA2022_GEBD(mode), batch_size=BATCH_SIZE, shuffle=False)
    network_list=[]
    device = torch.device('cuda')
    load_model = torch.load(args.model).to(device)
    network_list.append(load_model)


    f1_results = {}
    prec_results = {}
    rec_results = {}
    val_dicts = {}
    k = 3
    max_key = k
    max_value = 0
    print("sigma list:", SIGMA_LIST)
    for s in SIGMA_LIST:
        val_dict = {}
        gaussian_filter = torch.FloatTensor(
            [np.exp(-z*z/(2*s*s))/np.sqrt(2*np.pi*s*s) for z in range(-k, k+1)]
        ).to(device)
        gaussian_filter = gaussian_filter.unsqueeze(0).unsqueeze(0)
        gaussian_filter /= torch.max(gaussian_filter)
        gaussian_filter = gaussian_filter.repeat(1, FEATURE_LEN, 1)
        max_pooling = nn.MaxPool1d(5, stride=1, padding=2)

    test_dict = {}
    s = 0 
    print("TEST STARTS!")
    for feature, filenames, durations in tqdm(test_dataloader, ascii=True):
        feature = feature.to(device)
        num = 0
        pred= None
        with torch.no_grad():
            pred = torch.zeros([feature.shape[0], FEATURE_LEN]).to(device)
            for network in network_list:
                pred1, pred2, _, _, _ = network(feature)
                pred_tmp = torch.sigmoid(pred1)  # [BATCH_SIZE, FEATURE_LEN]
                pred_tmp = pred_tmp.reshape(feature.shape[0], FEATURE_LEN)
                pred += pred_tmp
            pred /= len(network_list)
             
            if s > 0:
                out = pred.unsqueeze(-1)
                eye = torch.eye(FEATURE_LEN).to(device)
                out = out * eye
                out = nn.functional.conv1d(out, gaussian_filter, padding=k)
            else:
                out = pred.unsqueeze(1)

            peak = (out == max_pooling(out))
            peak[out < THRESHOLD] = False
            peak = peak.squeeze()

            idx = torch.nonzero(peak).cpu().numpy()
        durations = durations.numpy()
        boundary_list = [[] for _ in range(len(out))]

        try:
            for i,j in idx :
                duration = durations[i]
                first = TIME_UNIT/2
                if first + TIME_UNIT*j < duration:
                    boundary_list[i].append(first + TIME_UNIT*j)
        except ValueError as e:
            for j in idx:
                duration = durations[0]
                first = TIME_UNIT/2
                if first + TIME_UNIT*j < duration:
                    boundary_list[0].append(first + TIME_UNIT*j)
                

        for i, boundary in enumerate(boundary_list):
            #filename = filenames[i]
            filename = os.path.basename(filenames[i])
            test_dict[filename] = boundary

    val_dicts[s] = test_dict
    f1, prec, rec = validate(test_dict, 0, mode, args.results_f1_json)
    f1_results[s] = f1
    prec_results[s] = prec
    rec_results[s] = rec

    print(f'f1: {f1_results}')
    print(f'precision: {prec_results}')
    print(f'recall: {rec_results}')


    with open(args.results_pred_json, 'w') as f:
        json_dump = json.dumps(test_dict, cls=NpEncoder)
        json_load = json.loads(json_dump) 
        json.dump(json_load, f, indent=4)
    
    print("TEST ENDS!")
